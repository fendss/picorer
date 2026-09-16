import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryArenaMeasuredEmbedder,
  type MemoryArenaAttemptMeteredEmbedder,
} from "../src/benchmark/memoryarena-public/adapters/measured-embedder.js";
import {
  PicorerMemoryArenaAdapter,
  memoryArenaPicorerRunFailure,
  memoryArenaPublicScopeId,
  memoryArenaRetryableUpstreamError,
  memoryArenaUpstreamAuthStatus,
} from "../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.js";
import {
  acquireMemoryArenaPublicDataDirectoryLease,
  createMemoryArenaPublicRuntime,
} from "../src/benchmark/memoryarena-public/composition/create-runtime.js";
import { createRetrievalContext } from "../src/composition/create-retrieval-context.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import type {
  PicorerResult,
  RunPicorerOptions,
} from "../src/evidence-agent/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import { OpenAICompatibleEmbedder } from "../src/retrieval/adapters/openai/openai-compatible-embedder.js";
import {
  embeddingProfile,
  type EmbeddingMetrics,
  type EmbeddingRequestOptions,
  type SearchOperatorDefinition,
} from "../src/retrieval/index.js";
import { sha256 } from "../src/util.js";

const temporaryDirectories: string[] = [];

class DeterministicEmbedder implements MemoryArenaAttemptMeteredEmbedder {
  readonly profileId = "memoryarena-test-profile";
  readonly model = "memoryarena-test-embedding";
  readonly dimensions = 2;
  readonly maxInputLength = 2048;
  readonly batchSize = 16;
  readonly inputs: string[] = [];
  private readonly attemptObserver = new AsyncLocalStorage<
    (metrics: EmbeddingMetrics) => void
  >();

  embedDocuments(
    texts: readonly string[],
    _options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    this.inputs.push(...texts);
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  embedQueries(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  snapshotMetrics(): EmbeddingMetrics {
    return { calls: this.inputs.length, latencyMs: 0 };
  }

  captureEmbeddingAttempts<T>(
    observer: (metrics: EmbeddingMetrics) => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.attemptObserver.run(observer, operation);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FailingDocumentEmbedder extends DeterministicEmbedder {
  constructor(private readonly failure: string) {
    super();
  }

  override embedDocuments(): Promise<number[][]> {
    return Promise.reject(new Error(this.failure));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-memoryarena-adapter-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reusableOperator(id = "reusable-recall"): SearchOperatorDefinition {
  return {
    id,
    version: "experiment-v1",
    guide: {
      summary: "Recall and deduplicate complementary evidence.",
      useWhen: ["A question needs evidence from several memories."],
      cost: "medium",
    },
    steps: [
      { id: "recall", kind: "search", operator: "hybrid" },
      { id: "unique", kind: "dedupe", input: "recall", by: "content" },
    ],
    output: "unique",
  };
}

function operatorExperimentResult(options: {
  question: string;
  definition?: SearchOperatorDefinition;
}): PicorerResult {
  const definition = options.definition;
  const definitionHash = definition === undefined
    ? undefined
    : sha256(JSON.stringify(definition));
  const cited = definition !== undefined;
  const evidenceContent = "Direct supporting evidence.";
  return {
    runId: `run-${options.question}`,
    scopeId: "scope-experiment",
    question: options.question,
    status: cited ? "sufficient" : "insufficient",
    citations: cited
      ? [{ memoryId: "memory-1", supports: "Direct supporting evidence." }]
      : [],
    evidenceSummary: cited ? evidenceContent : "No evidence.",
    candidates: [],
    evidence: cited
      ? [{
          memoryId: "memory-1",
          scopeId: "scope-experiment",
          sessionId: "session-1",
          turnIndex: 0,
          role: "other",
          content: evidenceContent,
          contentHash: sha256(evidenceContent),
          sourceContentHash: sha256(evidenceContent),
          sourceContentLength: evidenceContent.length,
          truncated: false,
          excerpts: [{
            start: 0,
            end: evidenceContent.length,
            content: evidenceContent,
          }],
          metadata: {},
        }]
      : [],
    trace: definition === undefined || definitionHash === undefined
      ? []
      : [{
          step: 1,
          toolCallId: "search-1",
          toolName: "search",
          args: { operator: definition.id },
          isError: false,
          details: {
            kind: "search",
            operator: definition.id,
            composition: { definitionHash },
            candidateReferences: [{ candidateRef: 1, memoryId: "memory-1" }],
          },
        }],
    operatorCatalog: { revision: 1, hash: "a".repeat(64) },
    operatorDefinitions: definition === undefined || definitionHash === undefined
      ? []
      : [{ revision: 1, definitionHash, definition }],
    metrics: {
      searchCalls: cited ? 1 : 0,
      readCalls: cited ? 1 : 0,
      bashCalls: 0,
      operatorDefinitionCalls: cited ? 1 : 0,
      candidateCount: cited ? 1 : 0,
      inspectedEvidenceCount: cited ? 1 : 0,
      evidenceCount: cited ? 1 : 0,
      citedCount: cited ? 1 : 0,
      retrievalProfile: "fts5",
      embeddingCalls: 0,
      embeddingLatencyMs: 0,
      denseCandidateCount: 0,
      rerankCandidateCount: 0,
      denseFallbackCount: 0,
      expiredNavigationResults: 0,
      compactedReadResults: 0,
    },
    retrieval: { retrievalProfile: "fts5" },
    retrievalModel: {
      providerId: "test",
      modelId: "test",
      responseModels: ["test"],
      thinkingLevel: "off",
      transport: "non-stream",
    },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function experimentAdapter(
  run: (options: RunPicorerOptions) => Promise<PicorerResult>,
): PicorerMemoryArenaAdapter {
  return new PicorerMemoryArenaAdapter({
    rawStore: {} as never,
    runtimeStore: {} as never,
    operatorRegistry: {} as never,
    embedder: {} as never,
    modelRuntime: {} as PiModelRuntime,
    runPicorerImpl: run,
  });
}

describe("MemoryArena Public Picorer adapter", () => {
  it("resolves a scope-specific retrieval context before running Picorer", async () => {
    const scopedStore = {} as RunPicorerOptions["store"];
    const scopedRegistry = {} as RunPicorerOptions["operatorRegistry"];
    const run = vi.fn(async ({ question }: RunPicorerOptions) =>
      operatorExperimentResult({ question })
    );
    const retrievalContextForScope = vi.fn(async () => ({
      store: scopedStore,
      operatorRegistry: scopedRegistry,
    }));
    const adapter = new PicorerMemoryArenaAdapter({
      rawStore: {} as never,
      runtimeStore: {} as never,
      operatorRegistry: {} as never,
      retrievalContextForScope,
      embedder: {} as never,
      modelRuntime: {} as PiModelRuntime,
      runPicorerImpl: run,
    });

    await adapter.retrieve({
      userId: "scoped-user",
      generation: 3,
      question: "What happened first?",
    });

    const scopeId = memoryArenaPublicScopeId("scoped-user", 3);
    expect(retrievalContextForScope).toHaveBeenCalledWith(scopeId);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      scopeId,
      store: scopedStore,
      operatorRegistry: scopedRegistry,
    }));
  });

  it("maps typed agent failures without exposing the raw model message", () => {
    for (const [picorerCode, expected] of [
      ["tool_protocol_exhausted", {
        code: "retrieval_agent_protocol_error",
        httpStatus: 422,
        retryable: false,
      }],
      ["turn_budget_exhausted", {
        code: "retrieval_agent_budget_exhausted",
        httpStatus: 422,
        retryable: false,
      }],
      ["tool_budget_exhausted", {
        code: "retrieval_agent_budget_exhausted",
        httpStatus: 422,
        retryable: false,
      }],
      ["run_timeout", {
        code: "retrieval_agent_timeout",
        httpStatus: 504,
        retryable: false,
      }],
      ["provider_error", {
        code: "upstream_failure",
        httpStatus: 502,
        retryable: false,
      }],
      ["runtime_error", {
        code: "retrieval_agent_failed",
        httpStatus: 500,
        retryable: false,
      }],
    ] as const) {
      const source = Object.assign(new Error("SECRET provider/model output"), {
        name: "PicorerRunError",
        code: picorerCode,
      });
      const mapped = memoryArenaPicorerRunFailure(source);
      expect(mapped, picorerCode).toMatchObject(expected);
      expect(mapped?.message, picorerCode).not.toContain("SECRET");
      expect(mapped?.cause, picorerCode).toBe(source);
    }
  });

  it("runs static experiments with the requested search cap and no definition budget", async () => {
    const runs: RunPicorerOptions[] = [];
    const adapter = experimentAdapter(async (options) => {
      runs.push(options);
      return operatorExperimentResult({ question: options.question });
    });

    const retrieval = await adapter.retrieve({
      userId: "static-user",
      generation: 1,
      question: "Static question?",
      operatorExperiment: {
        mode: "static",
        questionId: "static:q-1",
        maxSearchCalls: 3,
      },
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      question: "Static question?",
      maxSearchCalls: 3,
      maxOperatorDefinitions: 0,
      operatorDefinitions: [],
    });
    expect(retrieval.operatorExperiment).toEqual({
      mode: "static",
      questionId: "static:q-1",
      maxSearchCalls: 3,
      retrievalStatus: "insufficient",
      searchCalls: 0,
      operatorDefinitions: [],
    });
  });

  it("starts every ephemeral question without inherited definitions", async () => {
    const runs: RunPicorerOptions[] = [];
    const definition = reusableOperator();
    const adapter = experimentAdapter(async (options) => {
      runs.push(options);
      return operatorExperimentResult({
        question: options.question,
        definition,
      });
    });

    const first = await adapter.retrieve({
      userId: "ephemeral-user",
      generation: 1,
      question: "First question?",
      operatorExperiment: {
        mode: "ephemeral",
        questionId: "ephemeral:q-1",
        maxSearchCalls: 4,
      },
    });
    const second = await adapter.retrieve({
      userId: "ephemeral-user",
      generation: 1,
      question: "Second question?",
      operatorExperiment: {
        mode: "ephemeral",
        questionId: "ephemeral:q-2",
        maxSearchCalls: 4,
      },
    });

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => ({
      maxSearchCalls: run.maxSearchCalls,
      maxOperatorDefinitions: run.maxOperatorDefinitions,
      operatorDefinitions: run.operatorDefinitions,
    }))).toEqual([
      { maxSearchCalls: 4, maxOperatorDefinitions: 4, operatorDefinitions: [] },
      { maxSearchCalls: 4, maxOperatorDefinitions: 4, operatorDefinitions: [] },
    ]);
    expect(first.operatorExperiment).toMatchObject({
      mode: "ephemeral",
      questionId: "ephemeral:q-1",
      operatorDefinitions: [{ definition }],
    });
    expect(first).toMatchObject({
      evidenceSummary: "Direct supporting evidence.",
      evidence: [{
        memoryId: "memory-1",
        content: "Direct supporting evidence.",
        excerpts: [{ start: 0, end: 27 }],
      }],
    });
    expect(second.operatorExperiment).toMatchObject({
      mode: "ephemeral",
      questionId: "ephemeral:q-2",
      operatorDefinitions: [{ definition }],
    });
    expect(first.operatorExperiment).not.toHaveProperty("evolutionSnapshot");
    expect(second.operatorExperiment).not.toHaveProperty("evolutionSnapshot");
  });

  it("restores and advances cumulative operator evolution snapshots", async () => {
    const runs: RunPicorerOptions[] = [];
    const definition = reusableOperator();
    const adapter = experimentAdapter(async (options) => {
      runs.push(options);
      return operatorExperimentResult({
        question: options.question,
        definition,
      });
    });

    const first = await adapter.retrieve({
      userId: "cumulative-user",
      generation: 1,
      question: "First cumulative question?",
      operatorExperiment: {
        mode: "cumulative",
        questionId: "cumulative:q-1",
        maxSearchCalls: 4,
      },
    });
    const firstSnapshot = first.operatorExperiment?.evolutionSnapshot;
    expect(firstSnapshot).toMatchObject({
      sequence: 1,
      seenQuestionIds: ["cumulative:q-1"],
      entries: [{
        definition,
        phase: "provisional",
        successfulQuestionIds: ["cumulative:q-1"],
      }],
    });

    const second = await adapter.retrieve({
      userId: "cumulative-user",
      generation: 1,
      question: "Second cumulative question?",
      operatorExperiment: {
        mode: "cumulative",
        questionId: "cumulative:q-2",
        maxSearchCalls: 4,
        evolutionSnapshot: firstSnapshot!,
      },
    });

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      maxSearchCalls: 4,
      maxOperatorDefinitions: 4,
      operatorDefinitions: [],
    });
    expect(runs[1]).toMatchObject({
      maxSearchCalls: 4,
      maxOperatorDefinitions: 4,
      operatorDefinitions: [definition],
    });
    expect(second.operatorExperiment).toMatchObject({
      mode: "cumulative",
      questionId: "cumulative:q-2",
      observation: {
        questionId: "cumulative:q-2",
        decisions: [{ action: "credited", reason: "evidence-contributing" }],
      },
      evolutionSnapshot: {
        sequence: 2,
        seenQuestionIds: ["cumulative:q-1", "cumulative:q-2"],
        entries: [{
          definition,
          phase: "promoted",
          successfulQuestionIds: ["cumulative:q-1", "cumulative:q-2"],
        }],
      },
    });
  });

  it("appends raw chunks as independent other-role sessions and never seals", async () => {
    const directory = await temporaryDirectory();
    const store = await MemoryStore.create(join(directory, "memory.sqlite"));
    const embedder = new DeterministicEmbedder();
    const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
    const adapter = new PicorerMemoryArenaAdapter({
      rawStore: store,
      runtimeStore: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      embedder,
      modelRuntime: {} as PiModelRuntime,
    });
    const scopeId = memoryArenaPublicScopeId("user", 1);
    try {
      await adapter.appendOriginalChunk({
        userId: "user",
        generation: 1,
        ordinal: 0,
        chunk: "  first exact chunk\n",
      });
      await adapter.appendOriginalChunk({
        userId: "user",
        generation: 1,
        ordinal: 1,
        chunk: "second exact chunk",
      });
      await adapter.appendOriginalChunk({
        userId: "user",
        generation: 1,
        ordinal: 0,
        chunk: "  first exact chunk\n",
      });

      const records = store.listScopeRecords(scopeId);
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.role === "other")).toBe(true);
      expect(new Set(records.map((record) => record.sessionId)).size).toBe(2);
      expect(records.map((record) => record.content).sort()).toEqual([
        "  first exact chunk\n",
        "second exact chunk",
      ]);
      expect(store.hasPendingAppendRequests(scopeId)).toBe(false);
      expect(store.getOnlineScopeState(scopeId)).toBe("ingesting");
      expect(store.getEmbeddingIndexStatus(scopeId, embeddingProfile(embedder)))
        .toMatchObject({ total: 2, indexed: 2, missing: 0 });
    } finally {
      store.close();
    }
  });

  it("appends a visible conversation as exact role-aware turns in one session", async () => {
    const directory = await temporaryDirectory();
    const store = await MemoryStore.create(join(directory, "structured-memory.sqlite"));
    const embedder = new DeterministicEmbedder();
    const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
    const adapter = new PicorerMemoryArenaAdapter({
      rawStore: store,
      runtimeStore: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      embedder,
      modelRuntime: {} as PiModelRuntime,
    });
    const scopeId = memoryArenaPublicScopeId("structured-user", 1);
    try {
      await adapter.appendOriginalChunk({
        userId: "structured-user",
        generation: 1,
        ordinal: 0,
        chunk: "canonical public session identity",
        messages: [
          {
            role: "user",
            content: "exact user turn",
            timestamp: "2025-01-02T03:04:00",
          },
          {
            role: "assistant",
            content: "exact assistant turn",
            timestamp: "2025-01-02T03:04:00",
          },
        ],
      });

      const records = store.listScopeRecords(scopeId);
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.sessionId)).size).toBe(1);
      expect(records.map((record) => ({
        turnIndex: record.turnIndex,
        role: record.role,
        content: record.content,
        timestamp: record.timestamp,
      }))).toEqual([
        {
          turnIndex: 0,
          role: "user",
          content: "exact user turn",
          timestamp: "2025-01-02T03:04:00",
        },
        {
          turnIndex: 1,
          role: "assistant",
          content: "exact assistant turn",
          timestamp: "2025-01-02T03:04:00",
        },
      ]);
      expect(store.getEmbeddingIndexStatus(scopeId, embeddingProfile(embedder)))
        .toMatchObject({ total: 2, indexed: 2, missing: 0 });
    } finally {
      store.close();
    }
  });

  it("classifies only contextual transient upstream failures as retryable", () => {
    for (const message of [
      "HTTP 429 Too Many Requests",
      "HTTP 425 Too Early",
      "request failed with status code: 503",
      "ETIMEDOUT while reading response",
      "socket hang up",
    ]) {
      expect(memoryArenaRetryableUpstreamError(new Error(message)), message)
        .toBe(true);
    }
    for (const message of [
      "JSON parse error at position 429",
      "record UUID ends with 503",
      "HTTP 401 Unauthorized",
      "HTTP 403 Forbidden",
    ]) {
      expect(memoryArenaRetryableUpstreamError(new Error(message)), message)
        .toBe(false);
    }
  });

  it("maps HTTP 425 embedding failures to retryable upstream unavailability", async () => {
    const directory = await temporaryDirectory();
    const store = await MemoryStore.create(join(directory, "too-early.sqlite"));
    const embedder = new FailingDocumentEmbedder("HTTP 425 Too Early");
    const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
    const adapter = new PicorerMemoryArenaAdapter({
      rawStore: store,
      runtimeStore: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      embedder,
      modelRuntime: {} as PiModelRuntime,
    });
    try {
      await expect(adapter.appendOriginalChunk({
        userId: "too-early",
        generation: 1,
        ordinal: 0,
        chunk: "retry this chunk",
      })).rejects.toMatchObject({
        code: "upstream_unavailable",
        httpStatus: 503,
        retryable: true,
      });
    } finally {
      store.close();
    }
  });

  it("maps contextual upstream auth failures to exact non-retryable statuses", async () => {
    expect(memoryArenaUpstreamAuthStatus(new Error("HTTP status 401"))).toBe(401);
    expect(memoryArenaUpstreamAuthStatus(new Error("error code: 403"))).toBe(403);
    expect(memoryArenaUpstreamAuthStatus(new Error("invalid API key provided")))
      .toBe(401);
    expect(memoryArenaUpstreamAuthStatus(new Error("parse error at position 401")))
      .toBeUndefined();

    const directory = await temporaryDirectory();
    const store = await MemoryStore.create(join(directory, "auth.sqlite"));
    try {
      for (const [message, expected] of [
        ["HTTP 401 Unauthorized", {
          code: "upstream_unauthorized",
          httpStatus: 401,
          retryable: false,
        }],
        ["request failed with status code: 403", {
          code: "upstream_forbidden",
          httpStatus: 403,
          retryable: false,
        }],
      ] as const) {
        const embedder = new FailingDocumentEmbedder(message);
        const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
        const adapter = new PicorerMemoryArenaAdapter({
          rawStore: store,
          runtimeStore: retrieval.store,
          operatorRegistry: retrieval.operatorRegistry,
          embedder,
          modelRuntime: {} as PiModelRuntime,
        });
        await expect(adapter.appendOriginalChunk({
          userId: `auth-${expected.httpStatus}`,
          generation: 1,
          ordinal: 0,
          chunk: "auth failure seed",
        })).rejects.toMatchObject(expected);
      }
    } finally {
      store.close();
    }
  });

  it("attributes cross-user add and retrieval embeddings without gating the retrieval run", async () => {
    const directory = await temporaryDirectory();
    const store = await MemoryStore.create(join(directory, "concurrent.sqlite"));
    const documentStarted = deferred();
    const queryStarted = deferred();
    const documentRelease = deferred();
    const queryRelease = deferred();
    let activeFetches = 0;
    let maximumActiveFetches = 0;
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const document = body.input.some((input) => input.includes("first"));
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      (document ? documentStarted : queryStarted).resolve();
      await (document ? documentRelease : queryRelease).promise;
      activeFetches -= 1;
      const inputTokens = document ? 11 : 23;
      return new Response(JSON.stringify({
        data: body.input.map((_input, index) => ({
          index,
          embedding: [inputTokens, 1],
        })),
        usage: { prompt_tokens: inputTokens },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const rawEmbedder = new OpenAICompatibleEmbedder({
      baseUrl: "https://embedding.invalid/v1",
      apiKey: "test-key",
      dimensions: 2,
      maxInputLength: 2048,
      batchSize: 16,
      maxRetries: 0,
      fetchImpl,
    });
    const embedder = new MemoryArenaMeasuredEmbedder(rawEmbedder);
    const retrieval = createRetrievalContext(store, "picorer-hybrid", embedder);
    const retrievalStarted = deferred();
    const adapter = new PicorerMemoryArenaAdapter({
      rawStore: store,
      runtimeStore: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      embedder,
      modelRuntime: {} as PiModelRuntime,
      runPicorerImpl: async (options) => {
        retrievalStarted.resolve();
        await embedder.embedQueries([options.question]);
        return {
          runId: "retrieval-not-gated",
          scopeId: options.scopeId,
          question: options.question,
          status: "insufficient",
          citations: [],
          evidenceSummary: "",
          candidates: [],
          evidence: [],
          trace: [],
          metrics: {},
          retrieval: {},
          retrievalModel: {
            providerId: "test-provider",
            modelId: "test-retrieval",
            responseModels: ["test-retrieval"],
            thinkingLevel: "medium",
            transport: "non-stream",
          },
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        } as unknown as PicorerResult;
      },
    });
    try {
      const add = embedder.measureOperation(() => adapter.appendOriginalChunk({
        userId: "parallel-a",
        generation: 1,
        ordinal: 0,
        chunk: "first",
      }));
      await documentStarted.promise;
      const retrieve = embedder.measureOperation(() => adapter.retrieve({
        userId: "parallel-b",
        generation: 1,
        question: "Can retrieval pass the append gate?",
      }));
      await retrievalStarted.promise;
      await queryStarted.promise;
      expect(maximumActiveFetches).toBe(2);

      documentRelease.resolve();
      queryRelease.resolve();
      const [addResult, retrieveResult] = await Promise.all([add, retrieve]);

      expect(retrieveResult.result).toMatchObject({ runId: "retrieval-not-gated" });
      expect(addResult.embedding).toMatchObject({
        measurement: "async_context",
        delta: { calls: 1, inputTokens: 11, usageMissingCalls: 0 },
      });
      expect(retrieveResult.embedding).toMatchObject({
        measurement: "async_context",
        delta: { calls: 1, inputTokens: 23, usageMissingCalls: 0 },
      });
      expect(rawEmbedder.snapshotMetrics()).toMatchObject({
        calls: 2,
        inputTokens: 34,
        usageMissingCalls: 0,
      });
    } finally {
      documentRelease.resolve();
      queryRelease.resolve();
      store.close();
    }
  });

  it("refuses a second live process owner for one data directory", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireMemoryArenaPublicDataDirectoryLease(directory);
    try {
      await expect(acquireMemoryArenaPublicDataDirectoryLease(directory))
        .rejects.toThrow("already owned by process");
    } finally {
      await first.release();
    }
    const reacquired = await acquireMemoryArenaPublicDataDirectoryLease(directory);
    await reacquired.release();
  });

  it("exposes and closes the default durable operation audit", async () => {
    const directory = await temporaryDirectory();
    const runtime = await createMemoryArenaPublicRuntime({
      dataDir: directory,
      modelRuntime: {} as PiModelRuntime,
      embedder: new DeterministicEmbedder(),
    });
    try {
      expect(runtime.paths.operationAudits).toBe(
        join(directory, "operation-audits.jsonl"),
      );
      await runtime.backend.initialize({
        userId: "runtime-user",
        memorySystemName: "picorer",
      });
    } finally {
      await runtime.close();
    }

    const records = (await readFile(runtime.paths.operationAudits, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.phase)).toEqual([
      "start",
      "success",
    ]);
    expect(records[1]).toMatchObject({
      operation: "initialize",
      user_id: "runtime-user",
      generation: 1,
    });
  });

  it("fails closed when the database no longer matches its persistence marker", async () => {
    const directory = await temporaryDirectory();
    const runtime = await createMemoryArenaPublicRuntime({
      dataDir: directory,
      modelRuntime: {} as PiModelRuntime,
      embedder: new DeterministicEmbedder(),
    });
    await runtime.close();
    await unlink(runtime.paths.database);

    await expect(createMemoryArenaPublicRuntime({
      dataDir: directory,
      modelRuntime: {} as PiModelRuntime,
      embedder: new DeterministicEmbedder(),
    })).rejects.toThrow(
      "database and persistence identity must be created together",
    );
  });

  it("fails closed when Qdrant generation configuration is incomplete", async () => {
    await expect(createMemoryArenaPublicRuntime({
      dataDir: await temporaryDirectory(),
      modelRuntime: {} as PiModelRuntime,
      embedder: new DeterministicEmbedder(),
      retrievalProfile: "picorer-hybrid-qdrant-hnsw-v1",
      environment: {},
    })).rejects.toThrow("PICORER_VECTOR_GENERATION_ID");
  });
});
