import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  AMA_BENCH_JUDGE_PROMPT_VERSION,
  aggregateAmaBenchJudgeResults,
  amaBenchTokenF1,
  buildAmaBenchJudgePrompt,
  judgeAmaBenchQuestion,
  normalizeAmaBenchJudgeText,
  parseAmaBenchJudgeAnswer,
  type AmaBenchEvaluatorInput,
  type AmaBenchJudgeResult,
} from "../src/benchmark/amabench/index.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import { sha256 } from "../src/util.js";

function evaluatorInput(): AmaBenchEvaluatorInput {
  return {
    episode_id: 12,
    question_uuid: "11111111-1111-4111-8111-111111111111",
    task_type: "webarena",
    domain: "WEB",
    task_description: "Book the least expensive available room.",
    question: "Which room did the agent finally choose?",
    golden_answer: "The agent chose room 204.",
    predicted_answer: "Room 204.",
    qa_type: "B",
  };
}

function runtimeFor(
  text: string,
  observe?: (value: {
    systemPrompt: string | undefined;
    options: SimpleStreamOptions | undefined;
  }) => void,
): PiModelRuntime {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "gpt-4o-mini",
    responseModel: "gpt-4o-mini-2024-07-18",
    usage: {
      input: 100,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 102,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } satisfies AssistantMessage;
  return {
    modelAdapterId: "test-adapter",
    providerId: "test-provider",
    modelId: "gpt-4o-mini",
    thinkingLevel: "off",
    transport: "sse",
    model: {
      id: "gpt-4o-mini",
      name: "GPT-4o mini",
      api: "openai-completions",
      provider: "test-provider",
      baseUrl: "https://provider.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
    streamFn: (_model, context, options) => {
      observe?.({ systemPrompt: context.systemPrompt, options });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
    getApiKey: async () => "test-key",
  };
}

describe("AMA-Bench v4 official judge semantics", () => {
  it("pins the upstream binary judge prompt byte-for-byte", () => {
    const prompt = buildAmaBenchJudgePrompt(evaluatorInput());
    expect(prompt).toBe(`You are an expert evaluator. You will be given a question, a reference answer, and a predicted answer.
Your task is to determine if the predicted answer is correct based on:
1. Factual correctness compared to the reference
2. Completeness of the answer
3. Relevance to the question

Task Type: webarena
Episode ID: 12
Task Context: Book the least expensive available room.

Question: Which room did the agent finally choose?

Reference Answer: The agent chose room 204.

Predicted Answer: Room 204.

Is the predicted answer correct? Respond with ONLY "yes" or "no". Do not include any thinking process, explanation, or additional text.

Answer:<think></think>`);
    expect(AMA_BENCH_JUDGE_PROMPT_VERSION).toBe(
      "ama-bench-v4-official-binary-judge-v1",
    );
    expect(sha256(prompt)).toBe(
      "d93c3a8355fbf7d15caadd63187edb2b13773dffddf6c77e28fb3524daddc165",
    );
  });

  it("matches upstream normalization and multiset token F1 fallback", () => {
    expect(normalizeAmaBenchJudgeText("The Café, an APPLE!"))
      .toBe("café apple");
    expect(amaBenchTokenF1("red red blue", "red green")).toBeCloseTo(0.4);
    expect(amaBenchTokenF1("The", "an")).toBe(1);
    expect(amaBenchTokenF1("", "nonempty")).toBe(0);
  });

  it("removes think blocks and uses the final complete yes/no token", () => {
    expect(parseAmaBenchJudgeAnswer(
      "<think>yes, maybe</think> Yesterday was unclear. no ... YES!",
      "wrong",
      "right",
    )).toEqual({
      cleanedAnswer: "Yesterday was unclear. no ... YES!",
      decision: "yes",
      score: 1,
      fallback: { used: false },
    });
    expect(parseAmaBenchJudgeAnswer(
      "yes at first, but no",
      "right",
      "right",
    ).decision).toBe("no");
  });

  it("marks unparseable output and falls back to prediction-vs-gold F1", () => {
    expect(parseAmaBenchJudgeAnswer(
      "<think>not sure</think> uncertain",
      "red red blue",
      "red green",
    )).toEqual({
      cleanedAnswer: "uncertain",
      decision: "unparseable",
      score: 0.4,
      fallback: {
        used: true,
        reason: "unparseable-yes-no",
        metric: "token-f1",
        score: 0.4,
      },
    });
    expect(parseAmaBenchJudgeAnswer(
      "是yes的",
      "right",
      "wrong",
    ).decision).toBe("unparseable");
  });

  it("runs through the injected Pi runtime and records audit metadata", async () => {
    let observed: {
      systemPrompt: string | undefined;
      options: SimpleStreamOptions | undefined;
    } | undefined;
    const input = evaluatorInput();
    const result = await judgeAmaBenchQuestion({
      input,
      modelRuntime: runtimeFor(
        "<think>private reasoning says no</think> yes",
        (value) => {
          observed = value;
        },
      ),
    });

    expect(observed?.systemPrompt).toBe("");
    expect(observed?.options?.temperature).toBe(0);
    expect(result).toMatchObject({
      episodeId: 12,
      questionId: "11111111-1111-4111-8111-111111111111",
      domain: "WEB",
      taskType: "webarena",
      capability: "B",
      score: 1,
      decision: "yes",
      judgeAnswer: "<think>private reasoning says no</think> yes",
      cleanedJudgeAnswer: "yes",
      fallback: { used: false },
      model: {
        providerId: "test-provider",
        modelId: "gpt-4o-mini",
        responseModel: "gpt-4o-mini-2024-07-18",
      },
      prompt: {
        adapter: "ama-bench-v4-official-judge",
        version: AMA_BENCH_JUDGE_PROMPT_VERSION,
        hash: sha256(`\0${buildAmaBenchJudgePrompt(input)}`),
      },
    });
    expect(result.usage.totalTokens).toBe(102);
  });

  it("aggregates official avg_score and exact-one accuracy dimensions", async () => {
    const first = await judgeAmaBenchQuestion({
      input: evaluatorInput(),
      modelRuntime: runtimeFor("yes"),
    });
    const results: AmaBenchJudgeResult[] = [
      first,
      {
        ...first,
        questionId: "question-2",
        score: 0,
        decision: "no",
        capability: "C",
      },
      {
        ...first,
        questionId: "question-3",
        domain: "Game",
        taskType: "crafter",
        capability: "C",
        score: 0.5,
        decision: "unparseable",
        fallback: {
          used: true,
          reason: "unparseable-yes-no",
          metric: "token-f1",
          score: 0.5,
        },
      },
    ];

    expect(aggregateAmaBenchJudgeResults(results)).toEqual({
      overall: { count: 3, avgScore: 0.5, accuracy: 1 / 3 },
      byDomain: {
        Game: { count: 1, avgScore: 0.5, accuracy: 0 },
        WEB: { count: 2, avgScore: 0.5, accuracy: 0.5 },
      },
      byTaskType: {
        crafter: { count: 1, avgScore: 0.5, accuracy: 0 },
        webarena: { count: 2, avgScore: 0.5, accuracy: 0.5 },
      },
      byCapability: {
        B: { count: 1, avgScore: 1, accuracy: 1 },
        C: { count: 2, avgScore: 0.25, accuracy: 0 },
      },
    });
    expect(aggregateAmaBenchJudgeResults([]).overall).toEqual({
      count: 0,
      avgScore: 0,
      accuracy: 0,
    });
    expect(() => aggregateAmaBenchJudgeResults([{
      ...first,
      score: Number.NaN,
    }])).toThrow(/Invalid AMA-Bench judge score/u);
  });
});
