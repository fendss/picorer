import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  returnedModelMatches,
  runBenchmarkAnswer,
} from "../src/benchmark/index.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";

describe("benchmark answer boundary", () => {
  it("accepts dated deployments of the requested model", () => {
    expect(
      returnedModelMatches("gpt-4o-mini", "gpt-4o-mini-2024-07-18"),
    ).toBe(true);
  });

  it("accepts a canonical dated response for an explicit routing alias", () => {
    expect(
      returnedModelMatches(
        "gpt-5-mini-medium",
        "gpt-5-mini-2025-08-07",
      ),
    ).toBe(true);
    expect(
      returnedModelMatches(
        "gpt-5-mini-medium",
        "gpt-5-2025-08-07",
      ),
    ).toBe(false);
  });

  it("rejects provider model substitution", () => {
    expect(
      returnedModelMatches("gpt-4o-mini", "gpt-4.1-mini-2025-04-14"),
    ).toBe(false);
    expect(
      returnedModelMatches("gpt-5.4", "gpt-5.4-mini"),
    ).toBe(false);
  });

  it("forces deterministic sampling and execution checks only at the answer boundary", async () => {
    let streamOptions: SimpleStreamOptions | undefined;
    let observedSystemPrompt = "";
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "openai-completions",
      provider: "test-provider",
      model: "gpt-4o-mini",
      responseModel: "gpt-4o-mini-2024-07-18",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
    const runtime = {
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
        streamOptions = options;
        observedSystemPrompt = context.systemPrompt ?? "";
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
      getApiKey: async () => "test-key",
    } satisfies PiModelRuntime;

    const result = await runBenchmarkAnswer({
      modelRuntime: runtime,
      prompt: {
        adapterId: "longmemeval-s",
        promptVersion: "test",
        systemPrompt: "",
        userPrompt: "Question",
      },
      executionChecklist: `<answer_execution>
- Evaluate every requested item independently.
- Retrieval rank is not chronology.
- Follow the exact output syntax.
</answer_execution>`,
    });

    expect(streamOptions?.temperature).toBe(0);
    expect(observedSystemPrompt).toContain("Evaluate every requested item");
    expect(observedSystemPrompt).toContain("Retrieval rank is not chronology");
    expect(observedSystemPrompt).toContain("exact output syntax");
    expect(result.answer).toBe("Answer");
    message.content = [];
    await expect(runBenchmarkAnswer({
      modelRuntime: runtime,
      prompt: { adapterId: "test", promptVersion: "test", systemPrompt: "", userPrompt: "Question" },
    })).rejects.toMatchObject({
      name: "BenchmarkAnswerError",
      diagnostics: { usage: { input: 1, output: 1, totalTokens: 2 }, promptAdapter: "test" },
    });
  });

  it("does not change benchmark prompts unless the checklist is enabled", async () => {
    let observedSystemPrompt: string | undefined;
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "openai-completions",
      provider: "test-provider",
      model: "gpt-4o-mini",
      responseModel: "gpt-4o-mini-2024-07-18",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
    const runtime = {
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
      streamFn: (_model, context) => {
        observedSystemPrompt = context.systemPrompt;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
      getApiKey: async () => "test-key",
    } satisfies PiModelRuntime;

    await runBenchmarkAnswer({
      modelRuntime: runtime,
      prompt: {
        adapterId: "longmemeval-s",
        promptVersion: "test",
        systemPrompt: "historical system prompt",
        userPrompt: "Question",
      },
    });

    expect(observedSystemPrompt).toBe("historical system prompt");
  });
});
