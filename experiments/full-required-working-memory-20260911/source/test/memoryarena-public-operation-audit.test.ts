import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlMemoryArenaOperationAuditSink } from "../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.js";
import { FileMemoryArenaGenerationStore } from "../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.js";
import { PicorerMemoryArenaAdapter } from "../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.js";
import {
  MemoryArenaMeasuredEmbedder,
  type MemoryArenaAttemptMeteredEmbedder,
} from "../src/benchmark/memoryarena-public/adapters/measured-embedder.js";
import {
  MemoryArenaOperationDiagnosticError,
  MemoryArenaPublicError,
  MemoryArenaPublicMemoryBackend,
  type MemoryArenaChunkMemory,
  type MemoryArenaCommittedEvidence,
  type MemoryArenaEmbeddingOperationMeter,
  type MemoryArenaEmbeddingMetrics,
  type MemoryArenaEvidenceRetriever,
  type MemoryArenaOriginalChunk,
} from "../src/benchmark/memoryarena-public/index.js";
import {
  PicorerRunError,
  type PicorerFailureDiagnostics,
} from "../src/evidence-agent/index.js";
import { createRetrievalContext } from "../src/composition/create-retrieval-context.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import type { EmbeddingMetrics } from "../src/retrieval/index.js";

const temporaryDirectories: string[] = [];
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function temporaryPath(): Promise<{
  directory: string;
  state: string;
  audit: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-operation-audit-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    state: join(directory, "active-generations.json"),
    audit: join(directory, "operation-audits.jsonl"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactEvidence(
  memoryId: string,
  content: string,
): MemoryArenaCommittedEvidence {
  const contentHash = sha256(content);
  return {
    memoryId,
    scopeId: "test-scope",
    sessionId: memoryId,
    turnIndex: 0,
    role: "other",
    content,
    contentHash,
    sourceContentHash: contentHash,
    sourceContentLength: content.length,
    truncated: false,
    excerpts: [{ start: 0, end: content.length, content }],
    metadata: {},
  };
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  return value.trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

class RecordingEmbeddingMeter implements MemoryArenaEmbeddingOperationMeter {
  private readonly operations = new AsyncLocalStorage<MemoryArenaEmbeddingMetrics>();

  async measureOperation<T>(operation: () => Promise<T>) {
    const delta: MemoryArenaEmbeddingMetrics = {
      calls: 0,
      latencyMs: 0,
      inputTokens: 0,
      usageMissingCalls: 0,
    };
    const embedding = { measurement: "async_context" as const, delta };
    try {
      return {
        result: await this.operations.run(delta, operation),
        embedding,
      };
    } catch (error) {
      if (error instanceof MemoryArenaPublicError) {
        throw new MemoryArenaPublicError({
          code: error.code,
          message: error.message,
          httpStatus: error.httpStatus,
          retryable: error.retryable,
          cause: error,
          diagnostics: { embedding },
        });
      }
      throw new MemoryArenaOperationDiagnosticError({
        message: error instanceof Error ? error.message : "operation failed",
        cause: error,
        diagnostics: { embedding },
      });
    }
  }

  record(delta: MemoryArenaEmbeddingMetrics): void {
    const current = this.operations.getStore();
    if (current === undefined) throw new Error("No active embedding operation");
    current.calls += delta.calls;
    current.latencyMs += delta.latencyMs;
    current.inputTokens += delta.inputTokens;
    current.usageMissingCalls += delta.usageMissingCalls;
  }
}

class MetricChunks implements MemoryArenaChunkMemory {
  readonly appends: Array<{
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }> = [];
  private readonly chunks = new Map<string, string>();

  constructor(private readonly meter: RecordingEmbeddingMeter) {}

  async appendOriginalChunk(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }): Promise<void> {
    this.appends.push({ ...options });
    this.chunks.set(`m-${options.generation}-${options.ordinal}`, options.chunk);
    this.meter.record({
      calls: 1,
      latencyMs: 5,
      inputTokens: 7,
      usageMissingCalls: 0,
    });
  }

  async readOriginalChunks(options: {
    memoryIds: readonly string[];
  }): Promise<MemoryArenaOriginalChunk[]> {
    return options.memoryIds.flatMap((memoryId) => {
      const content = this.chunks.get(memoryId);
      return content === undefined ? [] : [{ memoryId, content }];
    });
  }
}

class FailedEmbeddingAttempt implements MemoryArenaAttemptMeteredEmbedder {
  readonly profileId: string;
  readonly model = "memoryarena-failed-embedding";
  readonly dimensions = 2;
  readonly maxInputLength = 2048;
  readonly batchSize = 1;
  private calls = 0;
  private latencyMs = 0;
  private inputTokens = 0;
  private usageMissingCalls = 0;
  private readonly attemptObserver = new AsyncLocalStorage<
    (metrics: EmbeddingMetrics) => void
  >();

  constructor(private readonly mode: "billed_then_429" | "unreported_429") {
    this.profileId = `memoryarena-failed-embedding-${mode}`;
  }

  embedDocuments(): Promise<number[][]> {
    if (this.mode === "billed_then_429") {
      this.record({ calls: 1, latencyMs: 5, inputTokens: 13, usageMissingCalls: 0 });
    }
    this.record({ calls: 1, latencyMs: 7, inputTokens: 0, usageMissingCalls: 1 });
    return Promise.reject(new Error("HTTP 429 Too Many Requests"));
  }

  embedQueries(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  snapshotMetrics(): EmbeddingMetrics {
    return {
      calls: this.calls,
      latencyMs: this.latencyMs,
      inputTokens: this.inputTokens,
      usageMissingCalls: this.usageMissingCalls,
    };
  }

  captureEmbeddingAttempts<T>(
    observer: (metrics: EmbeddingMetrics) => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.attemptObserver.run(observer, operation);
  }

  private record(metrics: EmbeddingMetrics): void {
    this.calls += metrics.calls;
    this.latencyMs += metrics.latencyMs;
    this.inputTokens += metrics.inputTokens ?? 0;
    this.usageMissingCalls += metrics.usageMissingCalls ?? 0;
    this.attemptObserver.getStore()?.(metrics);
  }
}

class SuccessfulMeteredEmbedder implements MemoryArenaAttemptMeteredEmbedder {
  readonly profileId = "memoryarena-successful-metered";
  readonly model = "memoryarena-successful-metered";
  readonly dimensions = 2;
  readonly maxInputLength = 2048;
  readonly batchSize = 1;
  private metrics: EmbeddingMetrics = {
    calls: 0,
    latencyMs: 0,
    inputTokens: 0,
    usageMissingCalls: 0,
  };
  private readonly attemptObserver = new AsyncLocalStorage<
    (metrics: EmbeddingMetrics) => void
  >();

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    this.record({ calls: 1, latencyMs: 4, inputTokens: 17, usageMissingCalls: 0 });
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  embedQueries(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  snapshotMetrics(): EmbeddingMetrics {
    return { ...this.metrics };
  }

  captureEmbeddingAttempts<T>(
    observer: (metrics: EmbeddingMetrics) => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.attemptObserver.run(observer, operation);
  }

  private record(metrics: EmbeddingMetrics): void {
    this.metrics = {
      calls: this.metrics.calls + metrics.calls,
      latencyMs: this.metrics.latencyMs + metrics.latencyMs,
      inputTokens: (this.metrics.inputTokens ?? 0) + (metrics.inputTokens ?? 0),
      usageMissingCalls: (this.metrics.usageMissingCalls ?? 0) +
        (metrics.usageMissingCalls ?? 0),
    };
    this.attemptObserver.getStore()?.(metrics);
  }
}

function lifecycleById(
  records: readonly Record<string, unknown>[],
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const operationId = String(record.operation_id);
    const values = grouped.get(operationId) ?? [];
    values.push(record);
    grouped.set(operationId, values);
  }
  return grouped;
}

async function failedAddTerminal(
  mode: "billed_then_429" | "unreported_429",
): Promise<Record<string, unknown>> {
  const paths = await temporaryPath();
  const store = await MemoryStore.create(join(paths.directory, "memory.sqlite"));
  const embedder = new MemoryArenaMeasuredEmbedder(
    new FailedEmbeddingAttempt(mode),
  );
  const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
  const chunks = new PicorerMemoryArenaAdapter({
    rawStore: store,
    runtimeStore: retrieval.store,
    operatorRegistry: retrieval.operatorRegistry,
    embedder,
    modelRuntime: {} as PiModelRuntime,
  });
  const sink = new JsonlMemoryArenaOperationAuditSink(paths.audit);
  const backend = new MemoryArenaPublicMemoryBackend({
    generations: new FileMemoryArenaGenerationStore(paths.state),
    chunks,
    retriever: chunks,
    audits: { record: async () => undefined },
    operationAudits: sink,
    embeddingMeter: embedder,
    memorySystemName: "picorer",
  });
  try {
    await backend.initialize({ userId: mode, memorySystemName: "picorer" });
    await expect(backend.add({
      userId: mode,
      memorySystemName: "picorer",
      chunk: "SECRET failed embedding chunk",
    })).rejects.toMatchObject({
      code: "upstream_unavailable",
      httpStatus: 503,
      retryable: true,
    });
    await sink.flush();
  } finally {
    store.close();
  }
  const terminal = parseJsonLines(await readFile(paths.audit, "utf8")).find(
    (record) => record.operation === "add" && record.phase === "failure",
  );
  if (terminal === undefined) throw new Error("Missing failed add terminal audit");
  return terminal;
}

describe("MemoryArena Public durable operation audit", () => {
  it("keeps billed embedding usage when a later batch fails retryably", async () => {
    const failure = await failedAddTerminal("billed_then_429");
    expect(failure).toMatchObject({
      status: "error",
      error_code: "upstream_unavailable",
      status_code: 503,
      retryable: true,
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 2,
          latency_ms: 12,
          input_tokens: 13,
          usage_missing_calls: 1,
        },
      },
    });
  });

  it("marks failed embedding calls whose provider usage is unavailable", async () => {
    const failure = await failedAddTerminal("unreported_429");
    expect(failure).toMatchObject({
      retryable: true,
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 1,
          latency_ms: 7,
          input_tokens: 0,
          usage_missing_calls: 1,
        },
      },
    });
  });

  it("keeps embedding usage when append completion fails after indexing", async () => {
    const paths = await temporaryPath();
    const store = await MemoryStore.create(join(paths.directory, "memory.sqlite"));
    const embedder = new MemoryArenaMeasuredEmbedder(
      new SuccessfulMeteredEmbedder(),
    );
    const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
    const chunks = new PicorerMemoryArenaAdapter({
      rawStore: store,
      runtimeStore: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      embedder,
      modelRuntime: {} as PiModelRuntime,
    });
    const completion = vi.spyOn(store, "markAppendRequestComplete")
      .mockImplementation(() => { throw new Error("append state disk failure"); });
    const sink = new JsonlMemoryArenaOperationAuditSink(paths.audit);
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(paths.state),
      chunks,
      retriever: chunks,
      audits: { record: async () => undefined },
      operationAudits: sink,
      embeddingMeter: embedder,
      memorySystemName: "picorer",
    });
    try {
      await backend.initialize({ userId: "completion", memorySystemName: "picorer" });
      await expect(backend.add({
        userId: "completion",
        memorySystemName: "picorer",
        chunk: "SECRET completion failure chunk",
      })).rejects.toMatchObject({ name: "MemoryArenaOperationDiagnosticError" });
      await sink.flush();
    } finally {
      completion.mockRestore();
      store.close();
    }
    const failure = parseJsonLines(await readFile(paths.audit, "utf8")).find(
      (record) => record.operation === "add" && record.phase === "failure",
    );
    expect(failure).toMatchObject({
      error_code: "internal_error",
      status_code: 500,
      retryable: false,
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 1,
          latency_ms: 4,
          input_tokens: 17,
          usage_missing_calls: 0,
        },
      },
    });
  });

  it("records privacy-safe lifecycle, retrieval usage, and embedding deltas", async () => {
    const paths = await temporaryPath();
    const meter = new RecordingEmbeddingMeter();
    const chunks = new MetricChunks(meter);
    const sink = new JsonlMemoryArenaOperationAuditSink(paths.audit);
    const retrievalUsage = {
      ...ZERO_USAGE,
      input: 31,
      output: 4,
      reasoning: 2,
      totalTokens: 35,
    };
    let retrievals = 0;
    const retriever: MemoryArenaEvidenceRetriever = {
      retrieve: async () => {
        retrievals += 1;
        meter.record({
          calls: 1,
          latencyMs: 3,
          inputTokens: 2,
          usageMissingCalls: 1,
        });
        return {
          runId: `retrieval-${retrievals}`,
          status: "sufficient",
          citations: [{
            memoryId: `m-1-${retrievals - 1}`,
            supports: "selected",
          }],
          evidenceSummary: "The committed passage is relevant.",
          evidence: [exactEvidence(
            `m-1-${retrievals - 1}`,
            retrievals === 1
              ? "SECRET first raw memory"
              : "SECRET second raw memory",
          )],
          trace: [],
          usage: retrievalUsage,
        };
      },
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(paths.state),
      chunks,
      retriever,
      audits: { record: async () => undefined },
      operationAudits: sink,
      embeddingMeter: meter,
      memorySystemName: "picorer",
    });
    const firstChunk = "SECRET first raw memory";
    const secondChunk = "SECRET second raw memory";
    const emptyQuestion = "SECRET empty question";
    const firstQuestion = "SECRET first question";
    const secondQuestion = "SECRET second question";

    await backend.initialize({ userId: "audit-user", memorySystemName: "picorer" });
    await backend.wrap({
      userId: "audit-user",
      memorySystemName: "picorer",
      question: emptyQuestion,
    });
    await backend.add({
      userId: "audit-user",
      memorySystemName: "picorer",
      chunk: firstChunk,
    });
    await backend.wrap({
      userId: "audit-user",
      memorySystemName: "picorer",
      question: firstQuestion,
    });
    await backend.add({
      userId: "audit-user",
      memorySystemName: "picorer",
      chunk: secondChunk,
    });
    await backend.wrap({
      userId: "audit-user",
      memorySystemName: "picorer",
      question: secondQuestion,
    });
    await sink.flush();

    const raw = await readFile(paths.audit, "utf8");
    for (const secret of [
      firstChunk,
      secondChunk,
      emptyQuestion,
      firstQuestion,
      secondQuestion,
    ]) expect(raw).not.toContain(secret);
    const records = parseJsonLines(raw);
    expect(records).toHaveLength(12);
    expect((await stat(paths.audit)).mode & 0o777).toBe(0o600);
    for (const lifecycle of lifecycleById(records).values()) {
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle.map((record) => record.phase)).toEqual([
        "start",
        expect.stringMatching(/^(?:success|failure)$/),
      ]);
      expect(lifecycle.every((record) =>
        Number.isFinite(Date.parse(String(record.timestamp)))
      )).toBe(true);
    }

    const initializeSuccess = records.find((record) =>
      record.operation === "initialize" && record.phase === "success"
    );
    expect(initializeSuccess).toMatchObject({ generation: 1, status: "ok" });
    const addStarts = records.filter((record) =>
      record.operation === "add" && record.phase === "start"
    );
    expect(addStarts.map((record) => record.chunk_sha256)).toEqual([
      sha256(firstChunk),
      sha256(secondChunk),
    ]);
    const wrapStarts = records.filter((record) =>
      record.operation === "wrap_user_prompt" && record.phase === "start"
    );
    expect(wrapStarts.map((record) => record.question_sha256)).toEqual([
      sha256(emptyQuestion),
      sha256(firstQuestion),
      sha256(secondQuestion),
    ]);

    const addSuccesses = records.filter((record) =>
      record.operation === "add" && record.phase === "success"
    );
    expect(addSuccesses).toHaveLength(2);
    for (const success of addSuccesses) {
      expect(success).toMatchObject({
        embedding: {
          measurement: "async_context",
          delta: {
            calls: 1,
            latency_ms: 5,
            input_tokens: 7,
            usage_missing_calls: 0,
          },
        },
      });
    }
    const retrievalSuccesses = records.filter((record) =>
      record.operation === "wrap_user_prompt" && record.phase === "success" &&
      record.retrieval !== undefined
    );
    expect(retrievalSuccesses).toHaveLength(2);
    expect(retrievalSuccesses[0]).toMatchObject({
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 1,
          latency_ms: 3,
          input_tokens: 2,
          usage_missing_calls: 1,
        },
      },
      retrieval: {
        run_id: "retrieval-1",
        status: "sufficient",
        usage: { input: 31, output: 4, reasoning: 2, totalTokens: 35 },
      },
    });
    const emptyWrapSuccess = records.find((record) =>
      record.operation === "wrap_user_prompt" && record.phase === "success" &&
      record.retrieval === undefined
    );
    expect(emptyWrapSuccess).toMatchObject({
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 0,
          latency_ms: 0,
          input_tokens: 0,
          usage_missing_calls: 0,
        },
      },
    });
  });

  it("keeps failed Picorer usage and a content-free trace summary", async () => {
    const paths = await temporaryPath();
    const meter = new RecordingEmbeddingMeter();
    const chunks = new MetricChunks(meter);
    const sink = new JsonlMemoryArenaOperationAuditSink(paths.audit);
    const failureUsage = {
      ...ZERO_USAGE,
      input: 101,
      output: 9,
      cacheRead: 5,
      totalTokens: 115,
      cost: { ...ZERO_USAGE.cost, total: 0.42 },
    };
    const picorerFailure = new PicorerRunError("SECRET model failure", {
      runId: "failed-run-id",
      scopeId: "SECRET scope id",
      turns: 3,
      toolCalls: 2,
      lastAssistantText: "SECRET assistant text",
      candidates: [{}],
      evidence: [{}, {}],
      trace: [
        {
          step: 1,
          toolCallId: "SECRET tool call id",
          toolName: "search",
          args: { query: "SECRET query" },
          isError: false,
          content: "SECRET search result",
        },
        {
          step: 2,
          toolCallId: "SECRET second tool call id",
          toolName: "read",
          args: { memoryId: "SECRET memory id" },
          isError: true,
          details: "SECRET tool details",
        },
      ],
      usage: failureUsage,
    } as unknown as PicorerFailureDiagnostics);
    const retriever: MemoryArenaEvidenceRetriever = {
      retrieve: async () => {
        meter.record({
          calls: 2,
          latencyMs: 17,
          inputTokens: 23,
          usageMissingCalls: 0,
        });
        throw new MemoryArenaPublicError({
          code: "upstream_unavailable",
          message: "Picorer retrieval is temporarily unavailable",
          httpStatus: 503,
          retryable: true,
          cause: picorerFailure,
        });
      },
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(paths.state),
      chunks,
      retriever,
      audits: { record: async () => undefined },
      operationAudits: sink,
      embeddingMeter: meter,
      memorySystemName: "picorer",
    });
    await backend.initialize({ userId: "failure-user", memorySystemName: "picorer" });
    await backend.add({
      userId: "failure-user",
      memorySystemName: "picorer",
      chunk: "SECRET seed chunk",
    });
    await expect(backend.wrap({
      userId: "failure-user",
      memorySystemName: "picorer",
      question: "SECRET failing question",
    })).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
    await sink.flush();

    const raw = await readFile(paths.audit, "utf8");
    for (const secret of [
      "SECRET model failure",
      "SECRET scope id",
      "SECRET assistant text",
      "SECRET tool call id",
      "SECRET query",
      "SECRET search result",
      "SECRET memory id",
      "SECRET tool details",
      "SECRET seed chunk",
      "SECRET failing question",
    ]) expect(raw).not.toContain(secret);
    const failure = parseJsonLines(raw).find((record) =>
      record.operation === "wrap_user_prompt" && record.phase === "failure"
    );
    expect(failure).toMatchObject({
      status: "error",
      error_code: "upstream_unavailable",
      status_code: 503,
      retryable: true,
      embedding: {
        measurement: "async_context",
        delta: {
          calls: 2,
          latency_ms: 17,
          input_tokens: 23,
          usage_missing_calls: 0,
        },
      },
      retrieval: {
        run_id: "failed-run-id",
        turns: 3,
        tool_calls: 2,
        candidate_count: 1,
        evidence_count: 2,
        trace: {
          entries: 2,
          error_entries: 1,
          by_tool: { read: 1, search: 1 },
        },
        usage: { input: 101, output: 9, cacheRead: 5, totalTokens: 115 },
      },
    });
  });

  it("serializes concurrent lifecycle appends without corrupting JSONL", async () => {
    const paths = await temporaryPath();
    const sink = new JsonlMemoryArenaOperationAuditSink(paths.audit);
    const spans = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      sink.begin({
        operation: index % 2 === 0 ? "add" : "wrap_user_prompt",
        userId: `user-${index % 4}`,
        memorySystemName: "picorer",
        ...(index % 2 === 0
          ? { chunkSha256: sha256(`chunk-${index}`) }
          : { questionSha256: sha256(`question-${index}`) }),
      })
    ));
    await Promise.all(spans.map((span, index) => index % 3 === 0
      ? span.fail({ errorCode: "upstream_unavailable", retryable: true, httpStatus: 503 })
      : span.succeed({ generation: 1 })
    ));
    await sink.flush();

    const records = parseJsonLines(await readFile(paths.audit, "utf8"));
    expect(records).toHaveLength(48);
    expect(new Set(records.map((record) => record.event_id)).size).toBe(48);
    expect(lifecycleById(records).size).toBe(24);
    for (const lifecycle of lifecycleById(records).values()) {
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0]?.phase).toBe("start");
      expect(["success", "failure"]).toContain(lifecycle[1]?.phase);
    }
  });
});
