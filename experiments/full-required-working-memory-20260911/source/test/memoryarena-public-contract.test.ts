import { describe, expect, it, vi } from "vitest";
import {
  MemoryArenaPublicApiService,
  MemoryArenaPublicApplication,
  type MemoryArenaPublicBackend,
} from "../src/entrypoints/memoryarena-public-api/application.js";
import {
  parseMemoryArenaAddRequest,
  parseMemoryArenaInitializeRequest,
  parseMemoryArenaWrapRequest,
} from "../src/entrypoints/memoryarena-public-api/contracts.js";
import { memoryArenaHttpError } from "../src/entrypoints/memoryarena-public-api/http-errors.js";
import { MemoryArenaPublicError } from "../src/benchmark/memoryarena-public/index.js";

describe("MemoryArena Public official HTTP contract", () => {
  it("returns typed, content-free failure envelopes with safe run diagnostics", () => {
    const raw = Object.assign(new Error("SECRET raw provider failure"), {
      name: "PicorerRunError",
      code: "tool_protocol_exhausted",
      diagnostics: {
        runId: "run-safe-id",
        scopeId: "SECRET scope",
        turns: 3,
        toolCalls: 2,
        lastAssistantText: "SECRET assistant output",
        candidates: [{ content: "SECRET candidate" }],
        evidence: [{ content: "SECRET evidence" }],
        trace: [{
          toolName: "search",
          isError: false,
          args: { query: "SECRET query" },
          content: "SECRET result",
        }],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      },
    });
    const response = memoryArenaHttpError(new MemoryArenaPublicError({
      code: "retrieval_agent_protocol_error",
      message: "Picorer retrieval agent stopped without a valid finish result",
      httpStatus: 422,
      retryable: false,
      cause: raw,
    }));

    expect(response).toMatchObject({
      status: 422,
      code: "retrieval_agent_protocol_error",
      retryable: false,
      body: {
        detail: "Picorer retrieval agent stopped without a valid finish result",
        error_code: "retrieval_agent_protocol_error",
        retryable: false,
        diagnostics: {
          retrieval: {
            runId: "run-safe-id",
            turns: 3,
            toolCalls: 2,
            candidateCount: 1,
            evidenceCount: 1,
            trace: {
              entries: 1,
              errorEntries: 0,
              byTool: { search: 1 },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("SECRET");
  });

  it("keeps unknown exceptions behind a generic typed 500", () => {
    expect(memoryArenaHttpError(new Error("SECRET internal detail"))).toEqual({
      status: 500,
      code: "internal_error",
      retryable: false,
      body: {
        detail: "Internal Server Error",
        error_code: "internal_error",
        retryable: false,
      },
    });
  });

  it("accepts and maps the exact initialize/add/wrap payloads", () => {
    expect(parseMemoryArenaInitializeRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
    })).toEqual({ userId: "user-1", memorySystemName: "picorer" });
    expect(parseMemoryArenaAddRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
      chunk: "  exact chunk\n",
    })).toEqual({
      userId: "user-1",
      memorySystemName: "picorer",
      chunk: "  exact chunk\n",
    });
    expect(parseMemoryArenaAddRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
      chunk: "session identity",
      messages: [
        {
          role: "user",
          content: "exact turn one",
          timestamp: "2025-01-02T03:04:00",
        },
        { role: "assistant", content: "exact turn two" },
      ],
    })).toEqual({
      userId: "user-1",
      memorySystemName: "picorer",
      chunk: "session identity",
      messages: [
        {
          role: "user",
          content: "exact turn one",
          timestamp: "2025-01-02T03:04:00",
        },
        { role: "assistant", content: "exact turn two" },
      ],
    });
    expect(parseMemoryArenaWrapRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
      question: "What next?",
      answer_handoff: "evidence-aware-v1",
    })).toEqual({
      userId: "user-1",
      memorySystemName: "picorer",
      question: "What next?",
      answerHandoff: "evidence-aware-v1",
    });
    expect(() => parseMemoryArenaWrapRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
      question: "What next?",
      answer_handoff: "invented-format",
    })).toThrow(/answer_handoff must be evidence-aware-v1/u);
  });

  it("maps the cumulative operator experiment and returns its state audit", async () => {
    const evolutionSnapshot = {
      schemaVersion: 1 as const,
      capacity: 4,
      explorationSlots: 1,
      promotionQuestions: 2,
      sequence: 1,
      seenQuestionIds: ["context-1:q-1"],
      entries: [],
    };
    const experimentResult = {
      mode: "cumulative" as const,
      questionId: "context-1:q-2",
      maxSearchCalls: 4,
      retrievalStatus: "insufficient" as const,
      searchCalls: 3,
      operatorDefinitions: [],
      evolutionSnapshot: {
        ...evolutionSnapshot,
        sequence: 2,
        seenQuestionIds: ["context-1:q-1", "context-1:q-2"],
      },
    };
    const wrap = vi.fn(async (input) => ({
      userId: input.userId,
      prompt: `wrapped:${input.question}`,
      retrievalModel: {
        providerId: "test-provider",
        modelId: "gpt-5-mini-medium",
        responseModels: ["gpt-5-mini-2025-08-07"],
        thinkingLevel: "medium",
        transport: "non-stream" as const,
      },
      operatorExperiment: experimentResult,
    }));
    const service = new MemoryArenaPublicApiService(
      new MemoryArenaPublicApplication({
        initialize: vi.fn(),
        add: vi.fn(),
        wrap,
      } as unknown as MemoryArenaPublicBackend),
    );

    const request = {
      user_id: "u",
      memory_system_name: "picorer",
      question: "Q2?",
      operator_experiment: {
        mode: "cumulative",
        question_id: "context-1:q-2",
        max_search_calls: 4,
        evolution_snapshot: evolutionSnapshot,
      },
    };
    expect(parseMemoryArenaWrapRequest(request)).toEqual({
      userId: "u",
      memorySystemName: "picorer",
      question: "Q2?",
      operatorExperiment: {
        mode: "cumulative",
        questionId: "context-1:q-2",
        maxSearchCalls: 4,
        evolutionSnapshot,
      },
    });
    await expect(service.wrap(request)).resolves.toEqual({
      status: "ok",
      user_id: "u",
      prompt: "wrapped:Q2?",
      retrieval_model: {
        providerId: "test-provider",
        modelId: "gpt-5-mini-medium",
        responseModels: ["gpt-5-mini-2025-08-07"],
        thinkingLevel: "medium",
        transport: "non-stream",
      },
      operator_experiment: experimentResult,
    });
    expect(wrap).toHaveBeenCalledWith(expect.objectContaining({
      operatorExperiment: expect.objectContaining({
        mode: "cumulative",
        questionId: "context-1:q-2",
        maxSearchCalls: 4,
        evolutionSnapshot,
      }),
    }));
  });

  it("rejects persisted evolution state outside cumulative mode", () => {
    expect(() => parseMemoryArenaWrapRequest({
      user_id: "u",
      memory_system_name: "picorer",
      question: "Q?",
      operator_experiment: {
        mode: "ephemeral",
        question_id: "q-1",
        max_search_calls: 4,
        evolution_snapshot: {},
      },
    })).toThrow("evolution_snapshot requires cumulative mode");
  });

  it("rejects benchmark labels and every other non-contract field", () => {
    for (const field of ["gold", "answer", "label"]) {
      expect(() => parseMemoryArenaAddRequest({
        user_id: "user-1",
        memory_system_name: "picorer",
        chunk: "memory",
        [field]: "hidden",
      })).toThrow(`unsupported fields: ${field}`);
    }
    expect(() => parseMemoryArenaWrapRequest({
      user_id: "user-1",
      memory_system_name: "picorer",
      question: "question",
      evaluator_state: {},
    })).toThrow("unsupported fields: evaluator_state");
  });

  it("returns byte-compatible success envelopes", async () => {
    const backend: MemoryArenaPublicBackend = {
      initialize: vi.fn(async (input) => ({
        ...input,
        generation: 1,
      })),
      add: vi.fn(async (input) => ({ userId: input.userId, response: null })),
      wrap: vi.fn(async (input) => ({
        userId: input.userId,
        prompt: `<memory_context>\nNone\n</memory_context>\nUser: ${input.question}`,
      })),
    };
    const service = new MemoryArenaPublicApiService(
      new MemoryArenaPublicApplication(backend),
    );

    await expect(service.initialize({
      user_id: "u",
      memory_system_name: "picorer",
    })).resolves.toEqual({
      status: "ok",
      user_id: "u",
      memory_system_name: "picorer",
    });
    await expect(service.add({
      user_id: "u",
      memory_system_name: "picorer",
      chunk: "chunk",
    })).resolves.toEqual({ status: "ok", user_id: "u", response: null });
    await expect(service.wrap({
      user_id: "u",
      memory_system_name: "picorer",
      question: "Q?",
    })).resolves.toEqual({
      status: "ok",
      user_id: "u",
      prompt: "<memory_context>\nNone\n</memory_context>\nUser: Q?",
    });
  });
});
