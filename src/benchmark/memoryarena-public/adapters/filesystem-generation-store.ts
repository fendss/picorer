import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryArenaPublicError,
  userNotInitialized,
  type MemoryArenaGenerationState,
} from "../model/memory-backend.js";
import type { MemoryArenaGenerationStore } from "../ports/memory-backend.js";

interface PersistedGenerationState {
  schema_version: 1;
  users: MemoryArenaGenerationState[];
}

function chunkHash(chunk: string): string {
  return createHash("sha256").update(chunk).digest("hex");
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function cloneState(state: MemoryArenaGenerationState): MemoryArenaGenerationState {
  return {
    ...state,
    ...(state.pendingAppend === undefined
      ? {}
      : { pendingAppend: { ...state.pendingAppend } }),
  };
}

function cloneUsers(
  users: Map<string, MemoryArenaGenerationState>,
): Map<string, MemoryArenaGenerationState> {
  return new Map(
    [...users].map(([userId, state]) => [userId, cloneState(state)]),
  );
}

function parseState(value: unknown): Map<string, MemoryArenaGenerationState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MemoryArena generation state must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["schema_version"] !== 1 || !Array.isArray(record["users"])) {
    throw new Error("MemoryArena generation state has an unsupported schema");
  }
  const users = new Map<string, MemoryArenaGenerationState>();
  record["users"].forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`users[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const userId = stringValue(item["userId"], `users[${index}].userId`);
    const memorySystemName = stringValue(
      item["memorySystemName"],
      `users[${index}].memorySystemName`,
    );
    const generation = nonNegativeInteger(
      item["generation"],
      `users[${index}].generation`,
    );
    if (generation < 1) {
      throw new Error(`users[${index}].generation must be positive`);
    }
    const nextOrdinal = nonNegativeInteger(
      item["nextOrdinal"],
      `users[${index}].nextOrdinal`,
    );
    let pendingAppend: MemoryArenaGenerationState["pendingAppend"];
    if (item["pendingAppend"] !== undefined) {
      const pending = item["pendingAppend"];
      if (
        typeof pending !== "object" || pending === null || Array.isArray(pending)
      ) {
        throw new Error(`users[${index}].pendingAppend must be an object`);
      }
      const pendingRecord = pending as Record<string, unknown>;
      const ordinal = nonNegativeInteger(
        pendingRecord["ordinal"],
        `users[${index}].pendingAppend.ordinal`,
      );
      const hash = stringValue(
        pendingRecord["chunkHash"],
        `users[${index}].pendingAppend.chunkHash`,
      );
      if (ordinal !== nextOrdinal || !/^[a-f0-9]{64}$/u.test(hash)) {
        throw new Error(`users[${index}].pendingAppend is inconsistent`);
      }
      pendingAppend = { ordinal, chunkHash: hash };
    }
    if (users.has(userId)) throw new Error(`Duplicate MemoryArena user: ${userId}`);
    users.set(userId, {
      userId,
      memorySystemName,
      generation,
      nextOrdinal,
      ...(pendingAppend === undefined ? {} : { pendingAppend }),
    });
  });
  return users;
}

/** Durable active-generation sidecar. Expensive Picorer work never holds its lock. */
export class FileMemoryArenaGenerationStore implements MemoryArenaGenerationStore {
  private tail: Promise<void> = Promise.resolve();
  private users: Map<string, MemoryArenaGenerationState> | undefined;

  constructor(readonly path: string) {}

  initialize(
    userId: string,
    memorySystemName: string,
  ): Promise<MemoryArenaGenerationState> {
    return this.locked(async () => {
      const users = cloneUsers(await this.load());
      const previous = users.get(userId);
      const generation = (previous?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new Error(`MemoryArena generation overflow for user ${userId}`);
      }
      const state: MemoryArenaGenerationState = {
        userId,
        memorySystemName,
        generation,
        nextOrdinal: 0,
      };
      users.set(userId, state);
      await this.persist(users);
      this.users = users;
      return cloneState(state);
    });
  }

  get(userId: string): Promise<MemoryArenaGenerationState | undefined> {
    return this.locked(async () => {
      const state = (await this.load()).get(userId);
      return state === undefined ? undefined : cloneState(state);
    });
  }

  reserveAppend(options: {
    userId: string;
    generation: number;
    chunk: string;
  }): Promise<number> {
    return this.locked(async () => {
      const users = cloneUsers(await this.load());
      const state = this.active(users, options.userId, options.generation);
      const hash = chunkHash(options.chunk);
      if (state.pendingAppend !== undefined) {
        if (state.pendingAppend.chunkHash !== hash) {
          throw new MemoryArenaPublicError({
            code: "append_pending",
            message:
              `A different MemoryArena append is pending at ordinal ` +
              `${state.pendingAppend.ordinal}`,
            httpStatus: 503,
            retryable: true,
          });
        }
        return state.pendingAppend.ordinal;
      }
      state.pendingAppend = { ordinal: state.nextOrdinal, chunkHash: hash };
      await this.persist(users);
      this.users = users;
      return state.nextOrdinal;
    });
  }

  completeAppend(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }): Promise<MemoryArenaGenerationState> {
    return this.locked(async () => {
      const users = cloneUsers(await this.load());
      const state = this.active(users, options.userId, options.generation);
      const hash = chunkHash(options.chunk);
      if (
        state.pendingAppend?.ordinal !== options.ordinal ||
        state.pendingAppend.chunkHash !== hash
      ) {
        throw new MemoryArenaPublicError({
          code: "generation_conflict",
          message: "MemoryArena append completion does not match the reservation",
          httpStatus: 409,
        });
      }
      state.nextOrdinal = options.ordinal + 1;
      delete state.pendingAppend;
      await this.persist(users);
      this.users = users;
      return cloneState(state);
    });
  }

  private active(
    users: Map<string, MemoryArenaGenerationState>,
    userId: string,
    generation: number,
  ): MemoryArenaGenerationState {
    const state = users.get(userId);
    if (state === undefined) throw userNotInitialized();
    if (state.generation !== generation) {
      throw new MemoryArenaPublicError({
        code: "generation_conflict",
        message:
          `MemoryArena generation changed for user ${userId}: ` +
          `${generation} != ${state.generation}`,
        httpStatus: 409,
      });
    }
    return state;
  }

  private async load(): Promise<Map<string, MemoryArenaGenerationState>> {
    if (this.users !== undefined) return this.users;
    try {
      this.users = parseState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.users = new Map();
      } else {
        throw error;
      }
    }
    return this.users;
  }

  private async persist(users: Map<string, MemoryArenaGenerationState>): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const state: PersistedGenerationState = {
      schema_version: 1,
      users: [...users.values()]
        .map(cloneState)
        .sort((left, right) => left.userId.localeCompare(right.userId)),
    };
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = predecessor.then(() => current);
    await predecessor;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryArenaPublicError) throw error;
      throw new MemoryArenaPublicError({
        code: "state_unavailable",
        message: "MemoryArena generation state is unavailable",
        httpStatus: 503,
        retryable: true,
        cause: error,
      });
    } finally {
      release();
    }
  }
}
