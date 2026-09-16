import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPiModelRuntime,
} from "../src/platform/pi/load-model-runtime.js";
import { PiModelRuntimeAdapterRegistry } from "../src/platform/pi/model-runtime-adapter.js";

const temporaryDirectories: string[] = [];

async function createAgentDir(input?: {
  apiKey?: string;
  api?: string;
  modelApi?: string;
  defaultProvider?: string;
  defaultModel?: string;
  completionsCompat?: Record<string, unknown>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "picorer-model-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });

  const providerId = input?.defaultProvider ?? "test-provider";
  const modelId = input?.defaultModel ?? "test-model";
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: providerId,
      defaultModel: modelId,
      defaultThinkingLevel: "off",
    }),
    "utf8",
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [providerId]: {
          baseUrl: "http://127.0.0.1:9999/v1/",
          api: input?.api ?? "openai-completions",
          apiKey: input?.apiKey ?? "!printf 'unit-test-key'",
          compat: input?.api === "openai-responses"
            ? {
                supportsDeveloperRole: false,
                sessionAffinityFormat: "openai-nosession",
              }
            : {
                maxTokensField: "max_tokens",
                ...input?.completionsCompat,
              },
          models: [
            {
              id: modelId,
              name: "Test Model",
              ...(input?.modelApi === undefined
                ? {}
                : { api: input.modelApi }),
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 4_096,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
            {
              id: "override-model",
              name: "Override Model",
              input: ["text"],
              contextWindow: 64_000,
              maxTokens: 8_192,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          ],
        },
      },
    }),
    "utf8",
  );
  return agentDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("loadPiModelRuntime", () => {
  it("loads a reasoning chat-completions model without a catalog entry", async () => {
    const previous = process.env["PICORER_REASONING_TEST_KEY"];
    process.env["PICORER_REASONING_TEST_KEY"] = "runtime-only-key";
    try {
      const runtime = await loadPiModelRuntime({
        modelAdapterId: "openai-reasoning-completions",
        providerId: "reasoning-provider",
        modelId: "reasoning-model",
        baseUrl: "https://reasoning.example/v1",
        apiKeyEnv: "PICORER_REASONING_TEST_KEY",
      });
      expect(runtime.modelAdapterId).toBe("openai-reasoning-completions");
      expect(runtime.transport).toBe("non-stream");
      expect(runtime.requestPolicy).toEqual({
        timeoutMs: 120_000,
        maxRetries: 1,
        maxRetryDelayMs: 5_000,
      });
      expect(runtime.model).toMatchObject({
        api: "openai-completions",
        reasoning: true,
        compat: {
          supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens",
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env["PICORER_REASONING_TEST_KEY"];
      } else {
        process.env["PICORER_REASONING_TEST_KEY"] = previous;
      }
    }
  });

  it("accepts a freely registered protocol adapter", async () => {
    const registry = new PiModelRuntimeAdapterRegistry();
    registry.register({
      id: "custom-completions",
      defaultTransport: "sse",
      createModel(input) {
        return {
          id: input.modelId,
          name: input.modelId,
          provider: input.providerId,
          api: "openai-completions",
          baseUrl: input.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: input.contextWindow ?? 8_192,
          maxTokens: input.maxTokens ?? 1_024,
        };
      },
    });
    const previous = process.env["PICORER_CUSTOM_TEST_KEY"];
    process.env["PICORER_CUSTOM_TEST_KEY"] = "runtime-only-key";
    try {
      const runtime = await loadPiModelRuntime({
        modelAdapterId: "custom-completions",
        modelAdapterRegistry: registry,
        providerId: "custom-provider",
        modelId: "model-not-in-any-catalog",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "PICORER_CUSTOM_TEST_KEY",
      });
      expect(runtime.modelAdapterId).toBe("custom-completions");
      expect(runtime.model.id).toBe("model-not-in-any-catalog");
    } finally {
      if (previous === undefined) delete process.env["PICORER_CUSTOM_TEST_KEY"];
      else process.env["PICORER_CUSTOM_TEST_KEY"] = previous;
    }
  });

  it("loads arbitrary Qwen model IDs through a protocol adapter without a catalog", async () => {
    const previous = process.env["PICORER_QWEN_TEST_KEY"];
    process.env["PICORER_QWEN_TEST_KEY"] = "runtime-only-key";
    try {
      const runtime = await loadPiModelRuntime({
        modelAdapterId: "qwen-completions",
        providerId: "siliconflow",
        modelId: "Qwen/a-future-model",
        baseUrl: "https://api.example/v1/",
        apiKeyEnv: "PICORER_QWEN_TEST_KEY",
        thinkingLevel: "high",
        contextWindow: 65_536,
        maxTokens: 4_096,
      });

      expect(runtime.modelAdapterId).toBe("qwen-completions");
      expect(runtime.modelId).toBe("Qwen/a-future-model");
      expect(runtime.requestPolicy).toEqual({
        timeoutMs: 1_800_000,
        maxRetries: 3,
        maxRetryDelayMs: 60_000,
      });
      expect(runtime.model).toMatchObject({
        id: "Qwen/a-future-model",
        provider: "siliconflow",
        api: "openai-completions",
        baseUrl: "https://api.example/v1",
        reasoning: true,
        contextWindow: 65_536,
        maxTokens: 4_096,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          thinkingFormat: "qwen",
        },
      });
      expect(await runtime.getApiKey("siliconflow")).toBe("runtime-only-key");
    } finally {
      if (previous === undefined) delete process.env["PICORER_QWEN_TEST_KEY"];
      else process.env["PICORER_QWEN_TEST_KEY"] = previous;
    }
  });

  it("loads only the configured default model and resolves its trusted command", async () => {
    const agentDir = await createAgentDir();
    const runtime = await loadPiModelRuntime({ agentDir });

    expect(runtime.providerId).toBe("test-provider");
    expect(runtime.modelId).toBe("test-model");
    expect(runtime.thinkingLevel).toBe("off");
    expect(runtime.transport).toBe("sse");
    expect(runtime.model).toMatchObject({
      id: "test-model",
      name: "Test Model",
      provider: "test-provider",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9999/v1",
      contextWindow: 32_000,
      maxTokens: 4_096,
      compat: { maxTokensField: "max_tokens" },
    });
    expect(typeof runtime.streamFn).toBe("function");
    expect(await runtime.getApiKey("another-provider")).toBeUndefined();
    expect(await runtime.getApiKey("test-provider")).toBe("unit-test-key");
  });

  it("selects the non-stream transport explicitly", async () => {
    const agentDir = await createAgentDir();
    const runtime = await loadPiModelRuntime({
      agentDir,
      transport: "non-stream",
    });

    expect(runtime.transport).toBe("non-stream");
    expect(typeof runtime.streamFn).toBe("function");
  });

  it("preserves Qwen thinking compatibility for the streaming transport", async () => {
    const agentDir = await createAgentDir({
      completionsCompat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        thinkingFormat: "qwen",
        supportsStrictMode: false,
      },
    });
    const runtime = await loadPiModelRuntime({
      agentDir,
      thinkingLevel: "high",
    });

    expect(runtime.thinkingLevel).toBe("high");
    expect(runtime.model).toMatchObject({
      api: "openai-completions",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "qwen",
        supportsStrictMode: false,
      },
    });
  });

  it("loads an openai-responses provider with the official streaming transport", async () => {
    const agentDir = await createAgentDir({ api: "openai-responses" });
    const runtime = await loadPiModelRuntime({ agentDir });

    expect(runtime.transport).toBe("sse");
    expect(runtime.model).toMatchObject({
      api: "openai-responses",
      compat: {
        supportsDeveloperRole: false,
        sessionAffinityFormat: "openai-nosession",
      },
    });
    expect(typeof runtime.streamFn).toBe("function");
  });

  it("allows a model to override its provider with openai-responses", async () => {
    const agentDir = await createAgentDir({
      api: "openai-completions",
      modelApi: "openai-responses",
    });
    const runtime = await loadPiModelRuntime({ agentDir });

    expect(runtime.model.api).toBe("openai-responses");
    expect(runtime.model.compat).toBeUndefined();
  });

  it("rejects the custom non-stream transport for openai-responses", async () => {
    const agentDir = await createAgentDir({ api: "openai-responses" });

    await expect(
      loadPiModelRuntime({ agentDir, transport: "non-stream" }),
    ).rejects.toThrow(
      "non-stream transport is only supported for openai-completions",
    );
  });

  it("selects an explicit configured model without changing settings", async () => {
    const agentDir = await createAgentDir();
    const runtime = await loadPiModelRuntime({
      agentDir,
      modelId: "override-model",
      thinkingLevel: "minimal",
    });

    expect(runtime.modelId).toBe("override-model");
    expect(runtime.thinkingLevel).toBe("minimal");
    expect(runtime.model).toMatchObject({
      id: "override-model",
      contextWindow: 64_000,
      maxTokens: 8_192,
    });
  });

  it("supports explicit env-name and base-url overrides without persisting a key", async () => {
    const agentDir = await createAgentDir();
    const previous = process.env["PICORER_TEST_API_KEY"];
    process.env["PICORER_TEST_API_KEY"] = "runtime-only-key";
    try {
      const runtime = await loadPiModelRuntime({
        agentDir,
        baseUrl: "https://provider.example/v1/",
        apiKeyEnv: "PICORER_TEST_API_KEY",
      });
      expect(runtime.model.baseUrl).toBe("https://provider.example/v1");
      expect(await runtime.getApiKey("test-provider")).toBe("runtime-only-key");
    } finally {
      if (previous === undefined) delete process.env["PICORER_TEST_API_KEY"];
      else process.env["PICORER_TEST_API_KEY"] = previous;
    }
  });

  it("rejects literal and environment API-key forms", async () => {
    const literalDir = await createAgentDir({
      apiKey: "literal-secret-value",
    });
    await expect(
      loadPiModelRuntime({ agentDir: literalDir }),
    ).rejects.toThrow("trusted !command");

    const environmentDir = await createAgentDir({
      apiKey: "$INJECTED_API_KEY",
    });
    await expect(
      loadPiModelRuntime({ agentDir: environmentDir }),
    ).rejects.toThrow("trusted !command");
  });

  it("does not disclose a failed command or its secret output", async () => {
    const agentDir = await createAgentDir({
      apiKey: "!printf 'do-not-disclose' >&2; exit 7",
    });
    const runtime = await loadPiModelRuntime({ agentDir });

    let message = "";
    try {
      await runtime.getApiKey("test-provider");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Configured API key command failed");
    expect(message).not.toContain("do-not-disclose");
    expect(message).not.toContain("printf");
  });

  it("rejects unsupported provider APIs before any model call", async () => {
    const agentDir = await createAgentDir({
      api: "anthropic-messages",
    });
    await expect(
      loadPiModelRuntime({ agentDir }),
    ).rejects.toThrow(
      "provider.api must be openai-completions or openai-responses",
    );
  });

  it("rejects unsupported model API overrides before any model call", async () => {
    const agentDir = await createAgentDir({
      modelApi: "anthropic-messages",
    });
    await expect(
      loadPiModelRuntime({ agentDir }),
    ).rejects.toThrow(
      "model.api must be openai-completions or openai-responses",
    );
  });
});
