import type { Model } from "@earendil-works/pi-ai";

export type AdaptedPiModel =
  | Model<"openai-completions">
  | Model<"openai-responses">;

export interface PiModelAdapterInput {
  providerId: string;
  modelId: string;
  baseUrl: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiModelRequestPolicy {
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
}

/**
 * Describes one provider protocol family, not one concrete model.
 * Concrete model IDs remain runtime inputs so catalog edits are unnecessary.
 */
export interface PiModelRuntimeAdapter {
  readonly id: string;
  readonly defaultTransport: "sse" | "non-stream";
  readonly requestPolicy?: PiModelRequestPolicy;
  createModel(input: PiModelAdapterInput): AdaptedPiModel;
}

export class PiModelRuntimeAdapterRegistry {
  readonly #adapters = new Map<string, PiModelRuntimeAdapter>();

  constructor(adapters: readonly PiModelRuntimeAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: PiModelRuntimeAdapter): void {
    const id = adapter.id.trim();
    if (!id) throw new Error("Model runtime adapter id must be non-empty");
    if (this.#adapters.has(id)) {
      throw new Error(`Model runtime adapter already registered: ${id}`);
    }
    this.#adapters.set(id, adapter);
  }

  resolve(id: string): PiModelRuntimeAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) {
      throw new Error(`Unknown model runtime adapter: ${id}`);
    }
    return adapter;
  }

  list(): readonly PiModelRuntimeAdapter[] {
    return [...this.#adapters.values()];
  }
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function openAiCompletionsAdapter(): PiModelRuntimeAdapter {
  return {
    id: "openai-completions",
    defaultTransport: "sse",
    requestPolicy: {
      timeoutMs: 90_000,
      maxRetries: 1,
      maxRetryDelayMs: 5_000,
    },
    createModel(input) {
      return {
        id: input.modelId,
        name: input.modelId,
        provider: input.providerId,
        api: "openai-completions",
        baseUrl: input.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: input.contextWindow ?? 128_000,
        maxTokens: input.maxTokens ?? 16_384,
      };
    },
  };
}

function openAiReasoningCompletionsAdapter(): PiModelRuntimeAdapter {
  return {
    id: "openai-reasoning-completions",
    defaultTransport: "non-stream",
    requestPolicy: {
      timeoutMs: 120_000,
      maxRetries: 1,
      maxRetryDelayMs: 5_000,
    },
    createModel(input) {
      return {
        id: input.modelId,
        name: input.modelId,
        provider: input.providerId,
        api: "openai-completions",
        baseUrl: input.baseUrl,
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: input.contextWindow ?? 128_000,
        maxTokens: input.maxTokens ?? 16_384,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens",
          supportsStrictMode: false,
        },
      };
    },
  };
}

function openAiResponsesAdapter(): PiModelRuntimeAdapter {
  return {
    id: "openai-responses",
    defaultTransport: "sse",
    createModel(input) {
      return {
        id: input.modelId,
        name: input.modelId,
        provider: input.providerId,
        api: "openai-responses",
        baseUrl: input.baseUrl,
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: input.contextWindow ?? 128_000,
        maxTokens: input.maxTokens ?? 16_384,
        compat: {
          supportsDeveloperRole: false,
          sessionAffinityFormat: "openai-nosession",
        },
      };
    },
  };
}

function qwenCompletionsAdapter(): PiModelRuntimeAdapter {
  return {
    id: "qwen-completions",
    defaultTransport: "sse",
    requestPolicy: {
      timeoutMs: 1_800_000,
      maxRetries: 3,
      maxRetryDelayMs: 60_000,
    },
    createModel(input) {
      return {
        id: input.modelId,
        name: input.modelId,
        provider: input.providerId,
        api: "openai-completions",
        baseUrl: input.baseUrl,
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: input.contextWindow ?? 32_768,
        maxTokens: input.maxTokens ?? 8_192,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "qwen",
          supportsStrictMode: false,
        },
      };
    },
  };
}

export function createDefaultPiModelRuntimeAdapterRegistry(): PiModelRuntimeAdapterRegistry {
  return new PiModelRuntimeAdapterRegistry([
    openAiCompletionsAdapter(),
    openAiReasoningCompletionsAdapter(),
    openAiResponsesAdapter(),
    qwenCompletionsAdapter(),
  ]);
}

export const DEFAULT_PI_MODEL_RUNTIME_ADAPTERS =
  createDefaultPiModelRuntimeAdapterRegistry();
