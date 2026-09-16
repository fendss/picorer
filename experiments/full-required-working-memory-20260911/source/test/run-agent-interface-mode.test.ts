import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import {
  PICORER_SKILL_TEXT,
  runPicorer,
  type PicorerRuntimeStore,
} from "../src/evidence-agent/index.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Picorer prompt and interface selection", () => {
  it("uses the complete v1.4 skill with the compact harness interface", async () => {
    const store: PicorerRuntimeStore = {
      search: () => [],
      read: () => [],
      findMentionedMemoryIds: () => [],
      getRecords: () => [],
    };
    let observedSystemPrompt = "";
    let observedQuestion = "";
    let observedTools: readonly { name: string; parameters: unknown }[] = [];
    const modelRuntime: PiModelRuntime = {
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
      streamFn: (_model, context) => {
        observedSystemPrompt = context.systemPrompt ?? "";
        observedQuestion = JSON.stringify(context.messages);
        observedTools = (context.tools ?? []).map((tool) => ({
          name: tool.name,
          parameters: tool.parameters,
        }));
        const message: AssistantMessage = {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "finish-1",
            name: "finish",
            arguments: { status: "insufficient" },
          }],
          api: "openai-completions",
          provider: "mock-provider",
          model: "mock-model",
          responseModel: "mock-model",
          usage: ZERO_USAGE,
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
        });
        return stream;
      },
      getApiKey: async () => "mock-key",
    };

    await runPicorer({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      modelRuntime,
      scopeId: "scope-1",
      question: "Find the current fact.",
      skill: "picorer-v0",
      interfaceMode: "compact",
    });

    expect(observedSystemPrompt).toContain(PICORER_SKILL_TEXT);
    expect(observedSystemPrompt).toContain("Context policy: compact working memory.");
    expect(observedSystemPrompt).toContain("<search_operator_catalog>");
    expect(observedSystemPrompt).toContain(
      "do not substitute world knowledge for a missing relation",
    );
    expect(observedSystemPrompt).not.toContain("cover every required relationship");
    expect(observedQuestion).toContain("Use or compose the available search operators");
    expect(observedQuestion).toContain(
      "Decide whether the acquired sources are adequate for answering",
    );
    expect(observedQuestion).not.toContain("cover every required relationship");
    expect(observedTools.map((tool) => tool.name)).toEqual([
      "search",
      "search_more",
      "define_operator",
      "read",
      "finish",
    ]);
    const finish = observedTools.find((tool) => tool.name === "finish");
    expect(JSON.stringify(finish?.parameters)).toContain(
      "consider the exact sources already read adequate for answering",
    );
    expect(JSON.stringify(finish?.parameters)).not.toContain("cover every fact");
    const search = observedTools.find((tool) => tool.name === "search");
    expect(Object.keys((search?.parameters as { properties: object }).properties)).toEqual([
      "workingMemory",
      "operator",
      "queries",
      "branches",
      "combine",
      "order",
      "maxPerSession",
      "limit",
    ]);
  });
});
