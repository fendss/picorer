import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMemoryArenaGenerationStore } from "../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.js";
import { renderEvidenceExcerpts } from "../src/evidence-agent/index.js";
import {
  MEMORYARENA_ANSWER_PROMPT_VERSION,
  MEMORYARENA_FULL_PARENT_HANDOFF_MAX_UTF8_BYTES,
  MemoryArenaPublicError,
  MemoryArenaPublicMemoryBackend,
  renderMemoryArenaEvidencePrompt,
  type MemoryArenaChunkMemory,
  type MemoryArenaCommittedEvidence,
  type MemoryArenaEmbeddingOperationMeter,
  type MemoryArenaEvidenceRetriever,
  type MemoryArenaOriginalChunk,
  type MemoryArenaOperationAuditSink,
  type MemoryArenaWrapAuditRecord,
  type MemoryArenaWrapAuditSink,
} from "../src/benchmark/memoryarena-public/index.js";

const temporaryDirectories: string[] = [];
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NOOP_OPERATION_AUDITS: MemoryArenaOperationAuditSink = {
  begin: async () => ({
    succeed: async () => undefined,
    fail: async () => undefined,
  }),
};
const NOOP_EMBEDDING_METER: MemoryArenaEmbeddingOperationMeter = {
  measureOperation: async (operation) => ({
    result: await operation(),
    embedding: {
      measurement: "async_context",
      delta: { calls: 0, latencyMs: 0, inputTokens: 0, usageMissingCalls: 0 },
    },
  }),
};

function exactEvidence(
  memoryId: string,
  content: string,
): MemoryArenaCommittedEvidence {
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
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

function projectedEvidence(
  memoryId: string,
  source: string,
  ranges: readonly { start: number; end: number }[],
): MemoryArenaCommittedEvidence {
  const excerpts = ranges.map(({ start, end }) => ({
    start,
    end,
    content: source.slice(start, end),
  }));
  const content = renderEvidenceExcerpts({
    sourceContentLength: source.length,
    excerpts,
  });
  return {
    ...exactEvidence(memoryId, content),
    sourceContentHash: createHash("sha256")
      .update(source, "utf8")
      .digest("hex"),
    sourceContentLength: source.length,
    truncated: true,
    excerpts,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-memoryarena-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "active-generations.json");
}

class MockChunks implements MemoryArenaChunkMemory {
  readonly appends: Array<{
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }> = [];
  readonly chunks = new Map<string, string>();
  readonly reads: string[][] = [];

  async appendOriginalChunk(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }): Promise<void> {
    this.appends.push({ ...options });
    this.chunks.set(`m-${options.generation}-${options.ordinal}`, options.chunk);
  }

  async readOriginalChunks(options: {
    memoryIds: readonly string[];
  }): Promise<MemoryArenaOriginalChunk[]> {
    this.reads.push([...options.memoryIds]);
    return options.memoryIds.flatMap((memoryId) => {
      const content = this.chunks.get(memoryId);
      return content === undefined ? [] : [{ memoryId, content }];
    });
  }
}

class RecordingAudits implements MemoryArenaWrapAuditSink {
  readonly records: MemoryArenaWrapAuditRecord[] = [];
  async record(record: MemoryArenaWrapAuditRecord): Promise<void> {
    this.records.push(record);
  }
}

describe("MemoryArena Public memory lifecycle", () => {
  it("hands off every immutable parent source returned by read", async () => {
    expect(MEMORYARENA_ANSWER_PROMPT_VERSION).toBe(
      "memoryarena-public-budgeted-full-parent-no-summary-no-status-20260831-v3",
    );
    const chunks = new MockChunks();
    const audits = new RecordingAudits();
    const retriever: MemoryArenaEvidenceRetriever = {
      retrieve: vi.fn(async () => chunks.appends.length === 2
        ? {
            runId: "run-1",
            status: "sufficient" as const,
            citations: [
              { memoryId: "m-1-1", supports: "direct" },
              { memoryId: "m-1-0", supports: "neighbor" },
            ],
            inventory: [{ item: "first", memoryIds: ["m-1-0", "m-1-1"] }],
            evidenceSummary: "Use the second and first exact passages.",
            evidence: [
              exactEvidence("m-1-1", "second <raw> chunk"),
              exactEvidence("m-1-0", "  first raw chunk\n"),
            ],
            trace: [{ toolName: "search" }, { toolName: "read" }],
            usage: {
              ...ZERO_USAGE,
              input: 40,
              output: 2,
              totalTokens: 42,
            },
            audit: { evidence_summary: "audit-only duplicate" },
          }
        : {
            runId: "run-2",
            status: "sufficient" as const,
            citations: [{ memoryId: "m-1-2", supports: "new evidence" }],
            evidenceSummary: "The third passage was added later.",
            evidence: [exactEvidence("m-1-2", "third chunk added after wrap")],
            trace: [{ toolName: "search" }],
            usage: ZERO_USAGE,
          }),
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(await statePath()),
      chunks,
      retriever,
      audits,
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    await backend.initialize({ userId: "u", memorySystemName: "picorer" });
    await expect(backend.wrap({
      userId: "u",
      memorySystemName: "picorer",
      question: "Empty?",
    })).resolves.toEqual({
      userId: "u",
      prompt: "<memory_context>\nNone\n</memory_context>\nUser: Empty?",
    });
    expect(retriever.retrieve).not.toHaveBeenCalled();

    await backend.add({
      userId: "u",
      memorySystemName: "picorer",
      chunk: "  first raw chunk\n",
    });
    await backend.add({
      userId: "u",
      memorySystemName: "picorer",
      chunk: "second <raw> chunk",
    });
    expect(chunks.appends).toEqual([
      { userId: "u", generation: 1, ordinal: 0, chunk: "  first raw chunk\n" },
      { userId: "u", generation: 1, ordinal: 1, chunk: "second <raw> chunk" },
    ]);

    const wrapped = await backend.wrap({
      userId: "u",
      memorySystemName: "picorer",
      question: "Which chunks?",
    });
    expect(wrapped.prompt).toBe([
      "<memory_context>",
      "<memory>second <raw> chunk</memory>",
      "<memory>  first raw chunk\n</memory>",
      "</memory_context>",
      "User: Which chunks?",
    ].join("\n"));
    expect(wrapped.prompt).not.toContain("audit-only duplicate");
    expect(audits.records.at(-1)).toMatchObject({
      generation: 1,
      nextOrdinal: 2,
      selectedMemoryIds: ["m-1-1", "m-1-0"],
      retrieval: { usage: { input: 40, output: 2, totalTokens: 42 } },
    });

    await backend.add({
      userId: "u",
      memorySystemName: "picorer",
      chunk: "third chunk added after wrap",
    });
    await expect(backend.wrap({
      userId: "u",
      memorySystemName: "picorer",
      question: "What was added later?",
    })).resolves.toEqual({
      userId: "u",
      prompt: [
        "<memory_context>",
        "<memory>third chunk added after wrap</memory>",
        "</memory_context>",
        "User: What was added later?",
      ].join("\n"),
    });
    expect(retriever.retrieve).toHaveBeenCalledTimes(2);
    expect(chunks.reads).toEqual([
      ["m-1-1", "m-1-0"],
      ["m-1-2"],
    ]);
    expect(audits.records.at(-1)).toMatchObject({
      generation: 1,
      nextOrdinal: 3,
      selectedMemoryIds: ["m-1-2"],
    });
  });

  it("expands selected immutable parents when the complete package fits the budget", async () => {
    const chunks = new MockChunks();
    const source =
      "PARENT_ONLY_SECRET. First exact fact. Irrelevant middle. Second exact fact.";
    const firstStart = source.indexOf("First exact fact.");
    const secondStart = source.indexOf("Second exact fact.");
    const evidence = {
      ...projectedEvidence("m-1-0", source, [
        { start: firstStart, end: firstStart + "First exact fact.".length },
        { start: secondStart, end: secondStart + "Second exact fact.".length },
      ]),
      role: "user" as const,
      timestamp: "2025-01-02T03:04:00",
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(await statePath()),
      chunks,
      retriever: {
        retrieve: async () => ({
          runId: "projected-run",
          status: "sufficient",
          citations: [{ memoryId: evidence.memoryId, supports: "two facts" }],
          evidence: [evidence],
          trace: [],
          usage: ZERO_USAGE,
        }),
      },
      audits: new RecordingAudits(),
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    await backend.initialize({ userId: "u", memorySystemName: "picorer" });
    await backend.add({
      userId: "u",
      memorySystemName: "picorer",
      chunk: source,
    });

    const { prompt } = await backend.wrap({
      userId: "u",
      memorySystemName: "picorer",
      question: "What are the two facts?",
      answerHandoff: "evidence-aware-v1",
    });

    expect(prompt).toContain("First exact fact.");
    expect(prompt).toContain("Second exact fact.");
    expect(prompt.indexOf("First exact fact.")).toBeLessThan(
      prompt.indexOf("Second exact fact."),
    );
    expect(prompt).toContain("PARENT_ONLY_SECRET");
    expect(prompt).toContain("Irrelevant middle");
    expect(prompt).not.toContain("<retrieval_summary");
    expect(prompt).not.toContain("status=");
    expect(prompt).not.toContain("Two passages jointly answer the question.");
    expect(prompt).toContain('<memory_context authority="read_exact_sources">');
    expect(prompt).toContain("role: user");
    expect(prompt).toContain("timestamp: 2025-01-02T03:04:00");
    expect(chunks.reads).toEqual([["m-1-0"]]);

    const excerptPrompt = renderMemoryArenaEvidencePrompt(
      "What are the two facts?",
      {
        runId: "projected-run",
        status: "sufficient",
        citations: [{ memoryId: evidence.memoryId, supports: "two facts" }],
        evidenceSummary: "This audit-only note must not reach the answer prompt.",
        evidence: [evidence],
        trace: [],
        usage: ZERO_USAGE,
      },
    );
    expect(excerptPrompt).not.toContain("PARENT_ONLY_SECRET");
    const sameEvidenceWithInsufficientStatus = renderMemoryArenaEvidencePrompt(
      "What are the two facts?",
      {
        runId: "projected-run",
        status: "insufficient",
        citations: [{ memoryId: evidence.memoryId, supports: "two facts" }],
        evidenceSummary: "This audit-only note must not reach the answer prompt.",
        evidence: [evidence],
        trace: [],
        usage: ZERO_USAGE,
      },
    );
    expect(sameEvidenceWithInsufficientStatus).toBe(excerptPrompt);
  });

  it("keeps exact excerpts when complete selected parents exceed one global budget", () => {
    const source =
      `PARENT_ONLY_SECRET.${"x".repeat(MEMORYARENA_FULL_PARENT_HANDOFF_MAX_UTF8_BYTES)}` +
      " First exact fact.";
    const start = source.indexOf("First exact fact.");
    const evidence = projectedEvidence("m-large", source, [
      { start, end: start + "First exact fact.".length },
    ]);
    const retrieval = {
      runId: "large-parent-run",
      status: "sufficient" as const,
      citations: [{ memoryId: evidence.memoryId, supports: "fact" }],
      evidenceSummary: "Audit only.",
      evidence: [evidence],
      trace: [],
      usage: ZERO_USAGE,
    };
    const excerptPrompt = renderMemoryArenaEvidencePrompt("What fact?", retrieval);
    const budgetedPrompt = renderMemoryArenaEvidencePrompt(
      "What fact?",
      retrieval,
      new Map([[evidence.memoryId, source]]),
    );
    expect(budgetedPrompt).toBe(excerptPrompt);
    expect(budgetedPrompt).toContain("First exact fact.");
    expect(budgetedPrompt).not.toContain("PARENT_ONLY_SECRET");
  });

  it("does not replace committed evidence with a stale full parent", () => {
    const source = "original exact fact and unused context";
    const evidence = projectedEvidence("m1", source, [{ start: 0, end: 19 }]);
    const retrieval = { runId: "stale-parent", status: "sufficient" as const,
      citations: [{ memoryId: "m1", supports: "fact" }], evidence: [evidence],
      trace: [], usage: ZERO_USAGE };
    const prompt = renderMemoryArenaEvidencePrompt("Question", retrieval, new Map([["m1", "different fact"]]));
    expect(prompt).toBe(renderMemoryArenaEvidencePrompt("Question", retrieval));
    expect(prompt).toContain(evidence.excerpts[0]!.content);
    expect(prompt).not.toContain("different fact");
  });

  it("rejects a committed passage whose exact-content hash was altered", async () => {
    const chunks = new MockChunks();
    const evidence = {
      ...exactEvidence("m-1-0", "exact fact"),
      contentHash: "0".repeat(64),
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(await statePath()),
      chunks,
      retriever: {
        retrieve: async () => ({
          runId: "tampered-run",
          status: "sufficient",
          citations: [{ memoryId: evidence.memoryId, supports: "fact" }],
          evidenceSummary: "A passage was selected.",
          evidence: [evidence],
          trace: [],
          usage: ZERO_USAGE,
        }),
      },
      audits: new RecordingAudits(),
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    await backend.initialize({ userId: "u", memorySystemName: "picorer" });
    await backend.add({ userId: "u", memorySystemName: "picorer", chunk: "exact fact" });

    await expect(backend.wrap({
      userId: "u",
      memorySystemName: "picorer",
      question: "What fact?",
    })).rejects.toMatchObject({ code: "source_integrity_error" });
    expect(chunks.reads).toEqual([]);
  });

  it("creates a clean generation on every repeated initialize", async () => {
    const chunks = new MockChunks();
    const retriever: MemoryArenaEvidenceRetriever = {
      retrieve: async () => ({
        runId: "unused",
        status: "insufficient",
        citations: [],
        evidenceSummary: "No committed evidence.",
        evidence: [],
        trace: [],
        usage: ZERO_USAGE,
      }),
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(await statePath()),
      chunks,
      retriever,
      audits: new RecordingAudits(),
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    expect((await backend.initialize({
      userId: "u",
      memorySystemName: "picorer",
    })).generation).toBe(1);
    await backend.add({ userId: "u", memorySystemName: "picorer", chunk: "old" });
    expect((await backend.initialize({
      userId: "u",
      memorySystemName: "picorer",
    })).generation).toBe(2);
    await backend.add({ userId: "u", memorySystemName: "picorer", chunk: "new" });
    expect(chunks.appends.at(-1)).toEqual({
      userId: "u",
      generation: 2,
      ordinal: 0,
      chunk: "new",
    });
  });

  it("preserves active generation, ordinal, and pending append across restart", async () => {
    const path = await statePath();
    const first = new FileMemoryArenaGenerationStore(path);
    await first.initialize("u", "picorer");
    expect(await first.reserveAppend({ userId: "u", generation: 1, chunk: "a" }))
      .toBe(0);

    const restartedPending = new FileMemoryArenaGenerationStore(path);
    expect(await restartedPending.reserveAppend({
      userId: "u",
      generation: 1,
      chunk: "a",
    })).toBe(0);
    await expect(restartedPending.reserveAppend({
      userId: "u",
      generation: 1,
      chunk: "different",
    })).rejects.toMatchObject({ retryable: true, code: "append_pending" });
    await restartedPending.completeAppend({
      userId: "u",
      generation: 1,
      ordinal: 0,
      chunk: "a",
    });

    const restartedComplete = new FileMemoryArenaGenerationStore(path);
    await expect(restartedComplete.get("u")).resolves.toMatchObject({
      generation: 1,
      nextOrdinal: 1,
    });
    await expect(restartedComplete.initialize("u", "picorer")).resolves.toMatchObject({
      generation: 2,
      nextOrdinal: 0,
    });
  });

  it("matches official uninitialized and mismatched-system errors", async () => {
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(await statePath()),
      chunks: new MockChunks(),
      retriever: { retrieve: async () => ({
        runId: "unused", status: "insufficient", citations: [], trace: [],
        evidenceSummary: "No committed evidence.", evidence: [],
        usage: ZERO_USAGE,
      }) },
      audits: new RecordingAudits(),
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    await expect(backend.wrap({
      userId: "missing",
      memorySystemName: "wrong",
      question: "Q",
    })).rejects.toMatchObject({ httpStatus: 404, message: "User not initialized" });
    await backend.initialize({ userId: "u", memorySystemName: "picorer" });
    await expect(backend.add({
      userId: "u",
      memorySystemName: "wrong",
      chunk: "x",
    })).rejects.toMatchObject({
      httpStatus: 400,
      message: "Mismatched memory_system for user",
    });
    await expect(backend.initialize({
      userId: "u",
      memorySystemName: "wrong",
    })).rejects.toBeInstanceOf(MemoryArenaPublicError);
  });
});
