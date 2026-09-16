import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runBenchmarkAnswer } from "../src/benchmark/index.js";
import { buildLongMemEvalAnswerPrompt } from "../src/benchmark/longmemeval/dataset-adapter.js";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import {
  PICORER_SKILL_TEXT,
  runPicorer,
  type PicorerRuntimeStore,
} from "../src/evidence-agent/index.js";
import type { MemoryRecord } from "../src/memory/index.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  usage: AssistantMessage["usage"] = ZERO_USAGE,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock-provider",
    model: "mock-model",
    responseModel: "mock-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedRuntime(
  messages: readonly AssistantMessage[],
  observedSystemPrompts: string[],
): PiModelRuntime {
  let next = 0;
  return {
    modelAdapterId: "test-adapter",
    providerId: "mock-provider",
    modelId: "mock-model",
    thinkingLevel: "off",
    transport: "sse",
    model: {
      id: "mock-model",
      name: "Mock model",
      api: "openai-completions",
      provider: "mock-provider",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    },
    streamFn: (_model, context, options) => {
      if (options?.signal?.aborted) {
        throw new Error(
          "Mock provider must not start work with an aborted signal",
        );
      }
      observedSystemPrompts.push(context.systemPrompt ?? "");
      const message = messages[next++];
      if (message === undefined) {
        throw new Error("Mock provider script was exhausted");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    },
    getApiKey: async () => "mock-key",
  };
}

describe("Picorer offline workflow", () => {
  it("does not start a model for an already cancelled run", async () => {
    const store: PicorerRuntimeStore = { search: () => [], read: () => [], findMentionedMemoryIds: () => [], getRecords: () => [] };
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const prompts: string[] = [];
    await expect(runPicorer({
      store, operatorRegistry: createSearchOperatorRegistry(store), modelRuntime: scriptedRuntime([], prompts),
      scopeId: "scope-1", question: "Question", signal: controller.signal,
    })).rejects.toBe(reason);
    expect(prompts).toEqual([]);
  });

  it("forwards caller cancellation to the active provider without starting repair turns", async () => {
    const store: PicorerRuntimeStore = { search: () => [], read: () => [], findMentionedMemoryIds: () => [], getRecords: () => [] };
    const controller = new AbortController();
    const runtime = scriptedRuntime([], []);
    let calls = 0;
    let providerAborted = false;
    runtime.streamFn = (_model, _context, options) => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      options!.signal!.addEventListener("abort", () => {
        providerAborted = true;
        const message = assistantMessage([], "aborted");
        stream.push({ type: "error", reason: "aborted", error: message });
      }, { once: true });
      queueMicrotask(() => controller.abort());
      return stream;
    };
    await expect(runPicorer({
      store, operatorRegistry: createSearchOperatorRegistry(store), modelRuntime: runtime,
      scopeId: "scope-1", question: "Question", signal: controller.signal, maxRunMs: 200,
    })).rejects.toMatchObject({ code: "runtime_error", message: "Picorer was cancelled by its caller" });
    expect(providerAborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("classifies provider failures without exposing the provider message", async () => {
    const store: PicorerRuntimeStore = {
      search: () => [],
      read: () => [],
      findMentionedMemoryIds: () => [],
      getRecords: () => [],
    };
    const providerFailure = assistantMessage([], "error");
    providerFailure.errorMessage = "Provider returned invalid JSON";

    await expect(runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([providerFailure], []),
      scopeId: "scope-1",
      question: "Will the provider return a valid response?",
    })).rejects.toMatchObject({
      name: "PicorerRunError",
      code: "provider_error",
      diagnostics: { providerFailureKind: "invalid_json" },
    });
  });

  it("records only the provider model id for a model substitution", async () => {
    const store: PicorerRuntimeStore = {
      search: () => [],
      read: () => [],
      findMentionedMemoryIds: () => [],
      getRecords: () => [],
    };
    const providerFailure = assistantMessage([], "error");
    providerFailure.errorMessage =
      "Provider substituted model gpt-4o-mini-alt; expected gpt-4o-mini";

    await expect(runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([providerFailure], []),
      scopeId: "scope-1",
      question: "Did the provider use the requested model?",
    })).rejects.toMatchObject({
      code: "provider_error",
      diagnostics: {
        providerFailureKind: "model_substitution",
        providerResponseModel: "gpt-4o-mini-alt",
      },
    });
  });

  it("finishes insufficient without asking the agent to build an evidence package", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-finish-guard",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "The guarded fact is blue.",
      contentHash: "hash-finish-guard",
      metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search: () => [{
        record: memory,
        query: "guarded fact",
        retriever: "fts5",
        rank: 1,
        score: 1,
        preview: memory.content,
      }],
      read: () => [memory],
      findMentionedMemoryIds: () => [],
      getRecords: () => [memory],
    };
    const observedPrompts: string[] = [];
    const runtime = scriptedRuntime([
      assistantMessage([{
        type: "toolCall",
        id: "search-finish-guard",
        name: "search",
        arguments: { operator: "lexical", queries: ["guarded fact"] },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "finish-without-evidence",
        name: "finish",
        arguments: {
          status: "insufficient",
          evidenceSummary: "No exact source was inspected, so the requested color remains unsupported.",
        },
      }], "toolUse"),
    ], observedPrompts);

    const result = await runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: runtime,
      scopeId: "scope-1",
      question: "What color is the guarded fact?",
      maxTurns: 64,
      maxToolCalls: 70,
    });
    expect(result.status).toBe("insufficient");
    expect(result.citations).toEqual([]);
    expect(result.trace.map((entry) => [entry.toolName, entry.isError])).toEqual([
      ["search", false],
      ["finish", false],
    ]);
    expect(observedPrompts).toHaveLength(2);
  });

  it("requires the model to observe inspect before semantic finish", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-finish-correction",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "The corrected fact is green.",
      contentHash: "hash-finish-correction",
      metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search: () => [{
        record: memory,
        query: "corrected fact",
        retriever: "fts5",
        rank: 1,
        score: 1,
        preview: memory.content,
      }],
      read: () => [memory],
      findMentionedMemoryIds: () => [],
      getRecords: () => [memory],
    };
    const result = await runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([
        assistantMessage([{
          type: "toolCall",
          id: "search-finish-correction",
          name: "search",
          arguments: { operator: "lexical", queries: ["corrected fact"] },
        }], "toolUse"),
        assistantMessage([
          {
            type: "toolCall",
            id: "inspect-finish-correction",
            name: "read",
            arguments: { candidateRefs: ["C1"] },
          },
          {
            type: "toolCall",
            id: "finish-corrected",
            name: "finish",
            arguments: {
              status: "sufficient",
              evidenceSummary: "This premature summary has not observed the exact inspect result.",
            },
          },
        ], "toolUse"),
        assistantMessage([{
          type: "toolCall",
          id: "finish-after-observation",
          name: "finish",
          arguments: {
            status: "sufficient",
            evidenceSummary: "The exact source states that the corrected fact is green.",
          },
        }], "toolUse"),
      ], []),
      scopeId: "scope-1",
      question: "What color is the corrected fact?",
    });

    expect(result.status).toBe("sufficient");
    expect(result.trace.map((entry) => [entry.toolName, entry.isError])).toEqual([
      ["search", false],
      ["read", false],
      ["finish", true],
      ["finish", false],
    ]);
    expect(result.evidenceSummary).toBe(
      "The exact source states that the corrected fact is green.",
    );
    expect(result.citations).toEqual([{
      memoryId: memory.memoryId,
      supports: "The corrected fact is green.",
    }]);
  });

  it("also bounds finish argument-schema correction loops", async () => {
    const store: PicorerRuntimeStore = {
      search: () => [],
      read: () => [],
      findMentionedMemoryIds: () => [],
      getRecords: () => [],
    };
    const observedPrompts: string[] = [];
    const malformedFinish = (id: string): AssistantMessage => assistantMessage([{
      type: "toolCall",
      id,
      name: "finish",
      arguments: { status: "not-a-valid-status" },
    }], "toolUse");

    await expect(runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([
        malformedFinish("finish-malformed-1"),
        malformedFinish("finish-malformed-2"),
      ], observedPrompts),
      scopeId: "scope-1",
      question: "Is there enough evidence?",
      maxTurns: 64,
      maxToolCalls: 70,
    })).rejects.toMatchObject({
      name: "PicorerRunError",
      code: "tool_protocol_exhausted",
      message: expect.stringMatching(/finish failed 2 times/iu),
      diagnostics: {
        toolCalls: 2,
        trace: [
          expect.objectContaining({ toolName: "finish", isError: true }),
          expect.objectContaining({ toolName: "finish", isError: true }),
        ],
      },
    });
    expect(observedPrompts).toHaveLength(2);
  });

  it("does not count a budget-rejected search as an executed search", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-budget",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "The budget test fact is blue.",
      contentHash: "hash-budget",
      metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search: () => [{
        record: memory,
        query: "budget blue",
        retriever: "fts5",
        rank: 1,
        score: 1,
        preview: memory.content,
      }],
      read: () => [memory],
      findMentionedMemoryIds: () => [],
      getRecords: () => [memory],
    };
    const runtime = scriptedRuntime([
      assistantMessage([{
        type: "toolCall",
        id: "search-allowed",
        name: "search",
        arguments: {
          operator: "lexical",
          queries: ["budget blue"],
          limit: 5,
        },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "search-rejected",
        name: "search",
        arguments: {
          operator: "lexical",
          queries: ["budget fact"],
          limit: 5,
        },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "inspect-budget",
        name: "read",
        arguments: { candidateRefs: ["C1"], contextBefore: 0, contextAfter: 0 },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "finish-budget",
        name: "finish",
        arguments: {
          status: "sufficient",
        },
      }], "toolUse"),
    ], []);

    const result = await runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: runtime,
      scopeId: "scope-1",
      question: "What color is the budget test fact?",
      maxSearchCalls: 1,
    });

    expect(result.trace.filter((item) => item.toolName === "search")).toHaveLength(2);
    expect(result.trace[1]).toMatchObject({
      toolName: "search",
      isError: true,
    });
    expect(result.metrics.searchCalls).toBe(1);
  });

  it("executes search -> inspect -> finish -> answer with one injected Skill", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-blue",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "My bicycle is blue.",
      contentHash: "hash-blue",
      metadata: {},
    };
    const unselectedNeighbor: MemoryRecord = {
      memoryId: "memory-unselected-neighbor",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 1,
      role: "assistant",
      content: "An unrelated neighboring turn.",
      contentHash: "hash-unselected-neighbor",
      metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search(_scopeId, request) {
        return [{
          record: memory,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: memory.content,
        }];
      },
      read(_scopeId, memoryIds) {
        return memoryIds.includes(memory.memoryId)
          ? [memory, unselectedNeighbor]
          : [];
      },
      findMentionedMemoryIds() {
        return [];
      },
      getRecords(_scopeId, memoryIds) {
        return memoryIds.includes(memory.memoryId) ? [memory] : [];
      },
    };
    const retrievalPrompts: string[] = [];
    const retrievalRuntime = scriptedRuntime([
      assistantMessage([{
        type: "toolCall",
        id: "search-1",
        name: "search",
        arguments: {
          operator: "lexical",
          queries: ["bicycle blue"],
          limit: 5,
        },
      }], "toolUse", {
        input: 10,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 13,
        cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 0, total: 4 },
      }),
      assistantMessage([{
        type: "toolCall",
        id: "inspect-1",
        name: "read",
        arguments: { candidateRefs: ["C1"] },
      }], "toolUse", {
        input: 20,
        output: 3,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 1,
        totalTokens: 26,
        cost: { input: 2, output: 3, cacheRead: 2, cacheWrite: 4, total: 11 },
      }),
      assistantMessage([{
        type: "toolCall",
        id: "finish-1",
        name: "finish",
        arguments: {
          status: "sufficient",
          evidenceSummary: "The exact source states that the user's bicycle is blue.",
        },
      }], "toolUse", {
        input: 30,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        cacheWrite1h: 1,
        reasoning: 2,
        totalTokens: 39,
        cost: { input: 3, output: 4, cacheRead: 3, cacheWrite: 8, total: 18 },
      }),
    ], retrievalPrompts);

    const retrieval = await runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: retrievalRuntime,
      scopeId: "scope-1",
      question: "What color is my bicycle?",
      skill: "picorer-v0",
    });

    const answerPrompts: string[] = [];
    const answerRuntime = scriptedRuntime([
      assistantMessage([{ type: "text", text: "Blue." }], "stop"),
    ], answerPrompts);
    const answer = await runBenchmarkAnswer({
      modelRuntime: answerRuntime,
      prompt: buildLongMemEvalAnswerPrompt(
        "What color is my bicycle?",
        retrieval,
      ),
    });

    expect(retrievalPrompts).toHaveLength(3);
    expect(retrievalPrompts[0]).toContain(PICORER_SKILL_TEXT);
    expect(retrievalPrompts[0]?.match(/<active_skill/gu)).toHaveLength(1);
    expect(retrieval.trace.map((item) => item.toolName)).toEqual([
      "search",
      "read",
      "finish",
    ]);
    expect(retrieval.metrics).toMatchObject({
      searchCalls: 1,
      readCalls: 1,
      candidateCount: 2,
      inspectedEvidenceCount: 2,
      evidenceCount: 2,
      citedCount: 2,
    });
    expect(retrieval.citations.map((item) => item.memoryId)).toEqual([
      memory.memoryId,
      unselectedNeighbor.memoryId,
    ]);
    expect(retrieval.evidence.map((item) => item.memoryId)).toContain(
      memory.memoryId,
    );
    expect(retrieval.evidence.map((item) => item.memoryId)).toContain(
      unselectedNeighbor.memoryId,
    );
    expect(retrieval.candidates.find((item) =>
      item.memoryId === unselectedNeighbor.memoryId
    )).toMatchObject({ inspected: true, committed: true });
    expect(retrieval.usage).toEqual({
      input: 60,
      output: 9,
      cacheRead: 6,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 3,
      totalTokens: 78,
      cost: {
        input: 6,
        output: 9,
        cacheRead: 6,
        cacheWrite: 12,
        total: 33,
      },
    });
    expect(answerPrompts).toHaveLength(1);
    expect(answer.answer).toBe("Blue.");
  });

  it("defines a run-local operator and uses it without mutating the base registry", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-runtime-operator",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "The migration codename is Cedar.",
      contentHash: "hash-cedar",
      metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search(_scopeId, request) {
        return [{
          record: memory,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: memory.content,
        }];
      },
      read: () => [memory],
      findMentionedMemoryIds: () => [],
      getRecords: () => [memory],
    };
    const registry = createSearchOperatorRegistry(store);
    const runtime = scriptedRuntime([
      assistantMessage([{
        type: "toolCall",
        id: "define-1",
        name: "define_operator",
        arguments: {
          id: "dual-recall",
          summary: "Fuse exact and semantic recall.",
          steps: [
            { id: "exact", kind: "search", operator: "lexical", limit: 5 },
            { id: "semantic", kind: "search", operator: "hybrid", limit: 5 },
            {
              id: "fused",
              kind: "combine",
              inputs: ["exact", "semantic"],
              method: "rrf",
            },
          ],
        },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "search-1",
        name: "search",
        arguments: {
          operator: "dual-recall",
          queries: ["migration codename"],
          limit: 5,
        },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "inspect-1",
        name: "read",
        arguments: { candidateRefs: ["C1"] },
      }], "toolUse"),
      assistantMessage([{
        type: "toolCall",
        id: "finish-1",
        name: "finish",
        arguments: {
          status: "sufficient",
          evidenceSummary: "The exact source states that the migration codename is Cedar.",
        },
      }], "toolUse"),
    ], []);

    const result = await runPicorer({
      store,
      operatorRegistry: registry,
      modelRuntime: runtime,
      scopeId: "scope-1",
      question: "What is the migration codename?",
    });

    expect(result.trace.map((item) => item.toolName)).toEqual([
      "define_operator",
      "search",
      "read",
      "finish",
    ]);
    expect(result.trace[1]?.details).toMatchObject({
      operator: "dual-recall",
      composition: { definitionRevision: 1 },
    });
    expect(result.operatorCatalog).toMatchObject({ revision: 1 });
    expect(result.operatorDefinitions).toEqual([
      expect.objectContaining({
        revision: 1,
        definition: expect.objectContaining({ id: "dual-recall" }),
      }),
    ]);
    expect(result.metrics.operatorDefinitionCalls).toBe(1);
    expect(() => registry.get("dual-recall")).toThrow(/unknown/iu);

    const replayPrompts: string[] = [];
    const replay = await runPicorer({
      store,
      operatorRegistry: registry,
      operatorDefinitions: result.operatorDefinitions!.map(
        (snapshot) => snapshot.definition,
      ),
      modelRuntime: scriptedRuntime([
        assistantMessage([{
          type: "toolCall",
          id: "search-2",
          name: "search",
          arguments: {
            operator: "dual-recall",
            queries: ["migration codename"],
            limit: 5,
          },
        }], "toolUse"),
        assistantMessage([{
          type: "toolCall",
          id: "inspect-2",
          name: "read",
          arguments: { candidateRefs: ["C1"] },
        }], "toolUse"),
        assistantMessage([{
          type: "toolCall",
          id: "finish-2",
          name: "finish",
          arguments: {
            status: "sufficient",
            evidenceSummary: "The exact source states that the migration codename is Cedar.",
          },
        }], "toolUse"),
      ], replayPrompts),
      scopeId: "scope-1",
      question: "What is the migration codename?",
    });

    expect(replayPrompts[0]).toContain("id=dual-recall | version=run-1");
    expect(replayPrompts[0]).not.toContain("dual-recall@run-1");
    expect(replay.trace.map((item) => item.toolName)).toEqual([
      "search",
      "read",
      "finish",
    ]);
    expect(replay.operatorCatalog).toEqual(result.operatorCatalog);
    expect(replay.metrics.operatorDefinitionCalls).toBe(0);
  });
  it("recovers finish after a successful read, without allowing prose to create evidence", async () => {
    const memory: MemoryRecord = {
      memoryId: "read-source", scopeId: "scope-1", sessionId: "session-1", turnIndex: 0,
      role: "user", content: "Arrives home at 6:30 pm.", contentHash: "read-source-hash", metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search: () => [{ record: memory, query: "arrival", retriever: "fts5", rank: 1, score: 1, preview: memory.content }],
      read: () => [memory], findMentionedMemoryIds: () => [], getRecords: () => [memory],
    };
    const action = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([{ type: "toolCall", id, name, arguments: args }], "toolUse");
    const output = await runPicorer({ store, operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([
        action("search", "search", { queries: ["arrival"] }),
        action("unread-finish", "finish", { status: "sufficient", workingMemory: "E999 proves 6:30 pm; C999 was discarded." }),
        action("read", "read", { candidateRefs: ["C1"], workingMemory: "x".repeat(1854) }),
        action("malformed-finish", "finish", { status: "invalid" }),
        action("finish", "finish", { status: "sufficient", evidenceSummary: null }),
      ], []), scopeId: "scope-1", question: "When does the user arrive home?",
      contextPolicy: "working-memory-rewrite", maxSearchCalls: 1,
    });
    expect(output.trace.map(t => [t.toolName, t.isError])).toEqual([
      ["search", false], ["finish", true], ["read", false], ["finish", true], ["finish", false],
    ]);
    expect(output.trace[2]!.details).toMatchObject({ workingMemoryUpdate: { rejected: true } });
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]!.memoryId).toBe(memory.memoryId);
    expect(output.evidenceSummary).toBeUndefined();
    expect(output.workingMemory).toMatchObject({ note: null, revision: 0 });
  });

  it("reads normally despite future evidence names and finishes despite a long optional note", async () => {
    const memory: MemoryRecord = {
      memoryId: "exact-source", scopeId: "scope-1", sessionId: "session-1", turnIndex: 0,
      role: "user", content: "The filing date is November 10.", contentHash: "exact-source-hash", metadata: {},
    };
    const store: PicorerRuntimeStore = {
      search: () => [{ record: memory, query: "filing", retriever: "fts5", rank: 1, score: 1, preview: memory.content }],
      read: () => [memory], findMentionedMemoryIds: () => [], getRecords: () => [memory],
    };
    const action = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([{ type: "toolCall", id, name, arguments: args }], "toolUse");
    const output = await runPicorer({ store, operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime: scriptedRuntime([
        action("search", "search", { queries: ["filing"], workingMemory: null }),
        action("read", "read", { candidateRefs: ["C1"], workingMemory: "Read C1 next to obtain E1. C999 is discarded." }),
        action("finish", "finish", { status: "sufficient", workingMemory: "x".repeat(1854), evidenceSummary: "  " }),
      ], []), scopeId: "scope-1", question: "When is the filing?", contextPolicy: "working-memory-rewrite",
    });
    expect(output.trace.every(t => !t.isError)).toBe(true);
    expect(output.trace[2]!.details).toMatchObject({ workingMemoryUpdate: { rejected: true } });
    expect(output.workingMemory).toMatchObject({ note: "Read C1 next to obtain E1. C999 is discarded." });
    expect(output.evidence.map(e => e.memoryId)).toEqual([memory.memoryId]);
    expect(output.citations.map(c => c.memoryId)).toEqual([memory.memoryId]);
    expect(output.evidenceSummary).toBeUndefined();
  });

});
