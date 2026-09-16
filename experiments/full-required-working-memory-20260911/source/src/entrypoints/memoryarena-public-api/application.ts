import { createHash } from "node:crypto";
import type {
  MemoryArenaAddInput,
  MemoryArenaAddResult,
  MemoryArenaInitializeInput,
  MemoryArenaInitializeResult,
  MemoryArenaWrapInput,
  MemoryArenaWrapResult,
} from "../../benchmark/memoryarena-public/index.js";
import { MemoryArenaPublicError } from "../../benchmark/memoryarena-public/index.js";
import {
  parseMemoryArenaAddRequest,
  parseMemoryArenaInitializeRequest,
  parseMemoryArenaWrapRequest,
} from "./contracts.js";
import type { MemoryArenaRuntimeIdentity } from "./runtime-contract.js";

export interface MemoryArenaPublicBackend {
  initialize(
    input: MemoryArenaInitializeInput,
  ): Promise<MemoryArenaInitializeResult>;
  add(input: MemoryArenaAddInput): Promise<MemoryArenaAddResult>;
  wrap(input: MemoryArenaWrapInput): Promise<MemoryArenaWrapResult>;
}

type LockMode = "read" | "write";

interface LockWaiter {
  mode: LockMode;
  resolve(): void;
}

interface KeyedLockState {
  activeReaders: number;
  writerActive: boolean;
  waiters: LockWaiter[];
}

/** A fair keyed read/write lock: mutations are exclusive, wraps are shared. */
class KeyedReadWriteExecutor {
  private readonly states = new Map<string, KeyedLockState>();

  runRead<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.run(key, "read", operation);
  }

  runWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.run(key, "write", operation);
  }

  private async run<T>(
    key: string,
    mode: LockMode,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(key, mode);
    try {
      return await operation();
    } finally {
      this.release(key, mode);
    }
  }

  private acquire(key: string, mode: LockMode): Promise<void> {
    const state = this.states.get(key) ?? {
      activeReaders: 0,
      writerActive: false,
      waiters: [],
    };
    this.states.set(key, state);
    return new Promise<void>((resolve) => {
      state.waiters.push({ mode, resolve });
      this.drain(state);
    });
  }

  private release(key: string, mode: LockMode): void {
    const state = this.states.get(key);
    if (state === undefined) throw new Error("Missing keyed lock state");
    if (mode === "read") state.activeReaders -= 1;
    else state.writerActive = false;
    this.drain(state);
    if (
      state.activeReaders === 0 &&
      !state.writerActive &&
      state.waiters.length === 0
    ) {
      this.states.delete(key);
    }
  }

  private drain(state: KeyedLockState): void {
    if (state.writerActive) return;
    if (state.activeReaders > 0 && state.waiters[0]?.mode === "write") return;
    if (state.activeReaders === 0 && state.waiters[0]?.mode === "write") {
      state.writerActive = true;
      state.waiters.shift()!.resolve();
      return;
    }
    while (state.waiters[0]?.mode === "read") {
      state.activeReaders += 1;
      state.waiters.shift()!.resolve();
    }
  }
}

export interface MemoryArenaAdmissionSnapshot {
  maximumConcurrent: number;
  active: number;
  queued: number;
  started: number;
  completed: number;
}

/** Bounds expensive retrieval agents without limiting cheap HTTP connections. */
class WrapAdmissionController {
  private active = 0;
  private started = 0;
  private completed = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximumConcurrent: number) {
    if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error("Wrap concurrency must be a positive integer");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    this.started += 1;
    try {
      return await operation();
    } finally {
      this.completed += 1;
      this.release();
    }
  }

  snapshot(): MemoryArenaAdmissionSnapshot {
    return {
      maximumConcurrent: this.maximumConcurrent,
      active: this.active,
      queued: this.waiters.length,
      started: this.started,
      completed: this.completed,
    };
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximumConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
  }
}

interface CoalescedRequest<T> {
  userId: string;
  promise: Promise<T>;
  expiresAt: number;
}

/** Shares an exact in-flight/recent wrap across HTTP transport retries. */
class WrapRequestCoalescer<T> {
  private readonly requests = new Map<string, CoalescedRequest<T>>();
  private coalesced = 0;

  constructor(
    private readonly successTtlMs: number,
    private readonly maximumEntries: number,
  ) {}

  run(key: string, userId: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    const existing = this.requests.get(key);
    if (existing !== undefined) {
      this.coalesced += 1;
      return existing.promise;
    }
    const request: CoalescedRequest<T> = {
      userId,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve(undefined as T),
    };
    request.promise = operation().then(
      (result) => {
        request.expiresAt = Date.now() + this.successTtlMs;
        this.prune();
        return result;
      },
      (error: unknown) => {
        if (this.requests.get(key) === request) this.requests.delete(key);
        throw error;
      },
    );
    this.requests.set(key, request);
    return request.promise;
  }

  invalidateUser(userId: string): void {
    for (const [key, request] of this.requests) {
      if (request.userId === userId) this.requests.delete(key);
    }
  }

  snapshot(): { entries: number; inFlight: number; coalesced: number } {
    this.prune();
    let inFlight = 0;
    for (const request of this.requests.values()) {
      if (!Number.isFinite(request.expiresAt)) inFlight += 1;
    }
    return { entries: this.requests.size, inFlight, coalesced: this.coalesced };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(key);
    }
    if (this.requests.size <= this.maximumEntries) return;
    for (const [key, request] of this.requests) {
      if (!Number.isFinite(request.expiresAt)) continue;
      this.requests.delete(key);
      if (this.requests.size <= this.maximumEntries) break;
    }
  }
}

export interface MemoryArenaPublicApplicationOptions {
  maximumConcurrentWraps?: number;
  completedWrapTtlMs?: number;
  maximumCachedWraps?: number;
}

/** Keeps lifecycle writes exclusive while parallelizing read-only retrievals. */
export class MemoryArenaPublicApplication {
  private readonly lifecycle = new KeyedReadWriteExecutor();
  private readonly admission: WrapAdmissionController;
  private readonly wraps: WrapRequestCoalescer<MemoryArenaWrapResult>;

  constructor(
    private readonly backend: MemoryArenaPublicBackend,
    options: MemoryArenaPublicApplicationOptions = {},
  ) {
    this.admission = new WrapAdmissionController(
      options.maximumConcurrentWraps ?? 16,
    );
    this.wraps = new WrapRequestCoalescer(
      options.completedWrapTtlMs ?? 15 * 60_000,
      options.maximumCachedWraps ?? 4_096,
    );
  }

  initialize(
    input: MemoryArenaInitializeInput,
  ): Promise<MemoryArenaInitializeResult> {
    return this.lifecycle.runWrite(input.userId, async () => {
      // Persistence can succeed before indexing/auditing fails. Cached reads
      // must not survive a write attempt whose effects cannot be rolled back.
      this.wraps.invalidateUser(input.userId);
      return this.backend.initialize(input);
    });
  }

  add(input: MemoryArenaAddInput): Promise<MemoryArenaAddResult> {
    return this.lifecycle.runWrite(input.userId, async () => {
      this.wraps.invalidateUser(input.userId);
      return this.backend.add(input);
    });
  }

  wrap(input: MemoryArenaWrapInput): Promise<MemoryArenaWrapResult> {
    return this.lifecycle.runRead(input.userId, () => this.wraps.run(
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      input.userId,
      () => this.admission.run(() => this.backend.wrap(input)),
    ));
  }

  health(): Record<string, unknown> {
    return {
      status: "ok",
      admission: this.admission.snapshot(),
      requests: this.wraps.snapshot(),
    };
  }
}

export class MemoryArenaPublicApiService {
  constructor(
    private readonly application: MemoryArenaPublicApplication,
    private readonly runtimeIdentity?: MemoryArenaRuntimeIdentity,
    private readonly persistenceIdentity?: string,
  ) {}

  async initialize(value: unknown): Promise<Record<string, unknown>> {
    const input = parseMemoryArenaInitializeRequest(value);
    const result = await this.application.initialize(input);
    return {
      status: "ok",
      user_id: result.userId,
      memory_system_name: result.memorySystemName,
    };
  }

  async add(value: unknown): Promise<Record<string, unknown>> {
    const input = parseMemoryArenaAddRequest(value);
    const result = await this.application.add(input);
    return {
      status: "ok",
      user_id: result.userId,
      response: result.response,
    };
  }

  async wrap(value: unknown): Promise<Record<string, unknown>> {
    const input = parseMemoryArenaWrapRequest(value);
    if (
      input.operatorExperiment !== undefined &&
      this.runtimeIdentity !== undefined &&
      input.operatorExperiment.maxSearchCalls !==
        this.runtimeIdentity.contract.limits.max_search_calls
    ) {
      throw new MemoryArenaPublicError({
        code: "contract_error",
        message: "Wrap search-call limit does not match the runtime contract",
        httpStatus: 422,
      });
    }
    const result = await this.application.wrap(input);
    return {
      status: "ok",
      user_id: result.userId,
      prompt: result.prompt,
      ...(result.retrievalModel === undefined
        ? {}
        : { retrieval_model: result.retrievalModel }),
      ...(result.operatorExperiment === undefined
        ? {}
        : { operator_experiment: result.operatorExperiment }),
    };
  }

  health(): Record<string, unknown> {
    return this.application.health();
  }

  runtime(): Record<string, unknown> {
    if (
      this.runtimeIdentity === undefined ||
      this.persistenceIdentity === undefined ||
      !this.persistenceIdentity.trim()
    ) {
      throw new Error("MemoryArena runtime identity is not configured");
    }
    return {
      status: "ok",
      runtime_contract: this.runtimeIdentity.contract,
      runtime_identity_sha256: this.runtimeIdentity.sha256,
      persistence_identity: this.persistenceIdentity,
    };
  }
}
