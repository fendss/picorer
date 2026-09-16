import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type {
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { openAINonStreamingStreamFn } from "./openai-non-stream-transport.js";
import {
  DEFAULT_PI_MODEL_RUNTIME_ADAPTERS,
  type PiModelRuntimeAdapter,
  type PiModelRuntimeAdapterRegistry,
  type PiModelRequestPolicy,
} from "./model-runtime-adapter.js";

type JsonObject = Record<string, unknown>;

export interface LoadPiModelRuntimeOptions {
  agentDir?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  baseUrl?: string;
  apiKeyEnv?: string;
  transport?: PiModelTransport;
  modelAdapterId?: string;
  modelAdapter?: PiModelRuntimeAdapter;
  modelAdapterRegistry?: PiModelRuntimeAdapterRegistry;
  contextWindow?: number;
  maxTokens?: number;
}

export type PiModelTransport = "sse" | "non-stream";
export type PiModelApi = "openai-completions" | "openai-responses";
export type PiModel =
  | Model<"openai-completions">
  | Model<"openai-responses">;

export interface PiModelRuntime {
  modelAdapterId: string;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  transport: PiModelTransport;
  model: PiModel;
  requestPolicy?: PiModelRequestPolicy;
  streamFn: StreamFn;
  getApiKey: (providerId: string) => Promise<string | undefined>;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function optionalCost(value: unknown, label: string): typeof DEFAULT_COST {
  if (value === undefined) return { ...DEFAULT_COST };
  const cost = asObject(value, label);
  const result = { ...DEFAULT_COST };
  for (const key of Object.keys(result) as Array<keyof typeof result>) {
    const rate = cost[key];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`${label}.${key} must be a non-negative number`);
    }
    result[key] = rate;
  }
  return result;
}

function optionalInput(value: unknown, label: string): ("text" | "image")[] {
  if (value === undefined) return ["text"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => item !== "text" && item !== "image")
  ) {
    throw new Error(`${label} must contain only text or image`);
  }
  return [...new Set(value)] as ("text" | "image")[];
}

function mergedCompat(
  providerValue: unknown,
  modelValue: unknown,
): JsonObject | undefined {
  const providerCompat =
    providerValue === undefined
      ? undefined
      : asObject(providerValue, "provider.compat");
  const modelCompat =
    modelValue === undefined ? undefined : asObject(modelValue, "model.compat");
  const raw = { ...providerCompat, ...modelCompat };
  if (Object.keys(raw).length === 0) return undefined;
  return raw;
}

function optionalCompletionsCompat(
  raw: JsonObject | undefined,
): OpenAICompletionsCompat | undefined {
  if (raw === undefined) return undefined;

  const result: OpenAICompletionsCompat = {};
  const booleanKeys = [
    "supportsStore",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsUsageInStreaming",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "requiresThinkingAsText",
    "requiresReasoningContentOnAssistantMessages",
    "supportsOpenAIGrammarTools",
    "supportsStrictMode",
    "sendSessionAffinityHeaders",
    "supportsLongCacheRetention",
  ] as const;
  for (const key of booleanKeys) {
    const value = raw[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`compat.${key} must be a boolean`);
    }
    if (value !== undefined) result[key] = value;
  }

  const maxTokensField = raw.maxTokensField;
  if (
    maxTokensField !== undefined &&
    maxTokensField !== "max_tokens" &&
    maxTokensField !== "max_completion_tokens"
  ) {
    throw new Error("compat.maxTokensField is invalid");
  }
  if (maxTokensField !== undefined) result.maxTokensField = maxTokensField;

  const thinkingFormat = raw.thinkingFormat;
  const thinkingFormats = new Set([
    "openai",
    "openrouter",
    "deepseek",
    "together",
    "zai",
    "qwen",
    "chat-template",
    "qwen-chat-template",
    "string-thinking",
    "ant-ling",
  ]);
  if (
    thinkingFormat !== undefined &&
    (typeof thinkingFormat !== "string" ||
      !thinkingFormats.has(thinkingFormat))
  ) {
    throw new Error("compat.thinkingFormat is invalid");
  }
  if (thinkingFormat !== undefined) {
    result.thinkingFormat =
      thinkingFormat as NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
  }

  const sessionAffinityFormat = raw.sessionAffinityFormat;
  if (
    sessionAffinityFormat !== undefined &&
    sessionAffinityFormat !== "openai" &&
    sessionAffinityFormat !== "openai-nosession" &&
    sessionAffinityFormat !== "openrouter"
  ) {
    throw new Error("compat.sessionAffinityFormat is invalid");
  }
  if (sessionAffinityFormat !== undefined) {
    result.sessionAffinityFormat = sessionAffinityFormat;
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function optionalResponsesCompat(
  raw: JsonObject | undefined,
): OpenAIResponsesCompat | undefined {
  if (raw === undefined) return undefined;

  const result: OpenAIResponsesCompat = {};
  const booleanKeys = [
    "supportsDeveloperRole",
    "supportsLongCacheRetention",
    "supportsStrictMode",
    "supportsOpenAIGrammarTools",
    "supportsToolSearch",
    "supportsExplicitPromptCacheMode",
  ] as const;
  for (const key of booleanKeys) {
    const value = raw[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`compat.${key} must be a boolean`);
    }
    if (value !== undefined) result[key] = value;
  }

  const sessionAffinityFormat = raw.sessionAffinityFormat;
  if (
    sessionAffinityFormat !== undefined &&
    sessionAffinityFormat !== "openai" &&
    sessionAffinityFormat !== "openai-nosession" &&
    sessionAffinityFormat !== "openrouter"
  ) {
    throw new Error("compat.sessionAffinityFormat is invalid");
  }
  if (sessionAffinityFormat !== undefined) {
    result.sessionAffinityFormat = sessionAffinityFormat;
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function supportedApi(value: unknown, label: string): PiModelApi {
  const api = asNonEmptyString(value, label);
  if (api !== "openai-completions" && api !== "openai-responses") {
    throw new Error(
      `${label} must be openai-completions or openai-responses`,
    );
  }
  return api;
}

function validateBaseUrl(value: unknown): string {
  const baseUrl = asNonEmptyString(value, "provider.baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("provider.baseUrl must be a valid URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "provider.baseUrl must use http or https and must not contain credentials",
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

async function parseJsonFile(path: string, label: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Unable to read ${label}`);
  }
  try {
    return asObject(JSON.parse(text) as unknown, label);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message !== `${label} must be an object`
    ) {
      throw new Error(`Unable to parse ${label}`);
    }
    throw error;
  }
}

function trustedCommand(apiKeyConfig: unknown): string {
  const configured = asNonEmptyString(
    apiKeyConfig,
    "provider.apiKey",
  );
  if (!configured.startsWith("!")) {
    throw new Error(
      "provider.apiKey must be a trusted !command from models.json",
    );
  }
  const command = configured.slice(1).trim();
  if (!command || command.includes("\0")) {
    throw new Error("provider.apiKey contains an invalid trusted command");
  }
  return command;
}

async function executeTrustedApiKeyCommand(command: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-lc", command],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, output) => {
        if (error) {
          reject(new Error("Configured API key command failed"));
          return;
        }
        resolve(output);
      },
    );
  });
  const apiKey = stdout.trim();
  if (!apiKey || apiKey.includes("\n") || apiKey.includes("\r")) {
    throw new Error("Configured API key command returned an invalid value");
  }
  return apiKey;
}

function thinkingLevelFor(value: unknown, label: string): ThinkingLevel {
  if (
    typeof value !== "string" ||
    !THINKING_LEVELS.has(value as ThinkingLevel)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value as ThinkingLevel;
}

function validatedApiKeyEnvironmentName(value: unknown): string {
  const name = asNonEmptyString(value, "apiKeyEnv");
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
    throw new Error("apiKeyEnv must be an environment variable name");
  }
  return name;
}

function environmentApiKeyResolver(
  providerId: string,
  environmentName: string,
): PiModelRuntime["getApiKey"] {
  return async (requestedProviderId) => {
    if (requestedProviderId !== providerId) return undefined;
    const apiKey = process.env[environmentName]?.trim();
    if (!apiKey || apiKey.includes("\n") || apiKey.includes("\r")) {
      throw new Error("Configured API key environment variable is invalid");
    }
    return apiKey;
  };
}

function streamFunctionFor(
  api: PiModelApi,
  transport: PiModelTransport,
): StreamFn {
  if (transport === "non-stream" && api !== "openai-completions") {
    throw new Error(
      "The non-stream transport is only supported for openai-completions models",
    );
  }
  return api === "openai-completions"
    ? transport === "non-stream"
      ? openAINonStreamingStreamFn
      : openAICompletionsApi().streamSimple
    : openAIResponsesApi().streamSimple;
}

function loadAdaptedPiModelRuntime(
  options: LoadPiModelRuntimeOptions,
): PiModelRuntime {
  if (options.modelAdapter !== undefined && options.modelAdapterId !== undefined) {
    throw new Error("Use either modelAdapter or modelAdapterId, not both");
  }
  const adapter = options.modelAdapter ??
    (options.modelAdapterRegistry ?? DEFAULT_PI_MODEL_RUNTIME_ADAPTERS).resolve(
      asNonEmptyString(options.modelAdapterId, "modelAdapterId"),
    );
  const providerId = asNonEmptyString(
    options.providerId ?? adapter.id,
    "provider override",
  );
  const modelId = asNonEmptyString(options.modelId, "model override");
  const baseUrl = validateBaseUrl(options.baseUrl);
  const apiKeyEnv = validatedApiKeyEnvironmentName(options.apiKeyEnv);
  const thinkingLevel = thinkingLevelFor(
    options.thinkingLevel ?? "off",
    "thinkingLevel",
  );
  const transport = options.transport ?? adapter.defaultTransport;
  const model = adapter.createModel({
    providerId,
    modelId,
    baseUrl,
    ...(options.contextWindow === undefined
      ? {}
      : {
          contextWindow: optionalPositiveInteger(
            options.contextWindow,
            1,
            "contextWindow",
          ),
        }),
    ...(options.maxTokens === undefined
      ? {}
      : {
          maxTokens: optionalPositiveInteger(
            options.maxTokens,
            1,
            "maxTokens",
          ),
        }),
  });
  if (model.id !== modelId || model.provider !== providerId) {
    throw new Error("Model runtime adapter changed the requested identity");
  }
  const api = supportedApi(model.api, "model adapter api");
  if (model.baseUrl !== baseUrl) {
    throw new Error("Model runtime adapter changed the requested base URL");
  }
  const requestPolicy = adapter.requestPolicy;
  const baseStreamFn = streamFunctionFor(api, transport);
  return {
    modelAdapterId: adapter.id,
    providerId,
    modelId,
    thinkingLevel,
    transport,
    model,
    ...(requestPolicy === undefined ? {} : { requestPolicy }),
    streamFn: requestPolicy === undefined
      ? baseStreamFn
      : (requestModel, context, streamOptions) =>
          baseStreamFn(requestModel, context, {
            timeoutMs: requestPolicy.timeoutMs,
            maxRetries: requestPolicy.maxRetries,
            maxRetryDelayMs: requestPolicy.maxRetryDelayMs,
            ...streamOptions,
          }),
    getApiKey: environmentApiKeyResolver(providerId, apiKeyEnv),
  };
}

export async function loadPiModelRuntime(
  options: LoadPiModelRuntimeOptions = {},
): Promise<PiModelRuntime> {
  if (options.modelAdapter !== undefined || options.modelAdapterId !== undefined) {
    return loadAdaptedPiModelRuntime(options);
  }
  if (
    options.modelAdapterRegistry !== undefined ||
    options.contextWindow !== undefined ||
    options.maxTokens !== undefined
  ) {
    throw new Error(
      "modelAdapterId is required for adapter registry or model limits",
    );
  }
  const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
  const [settings, modelsConfig] = await Promise.all([
    parseJsonFile(join(agentDir, "settings.json"), "settings.json"),
    parseJsonFile(join(agentDir, "models.json"), "models.json"),
  ]);

  const providerId = asNonEmptyString(
    options.providerId ?? settings.defaultProvider,
    options.providerId === undefined
      ? "settings.defaultProvider"
      : "provider override",
  );
  const modelId = asNonEmptyString(
    options.modelId ?? settings.defaultModel,
    options.modelId === undefined ? "settings.defaultModel" : "model override",
  );
  const rawThinkingLevel =
    options.thinkingLevel ?? settings.defaultThinkingLevel ?? "off";
  const thinkingLevel = thinkingLevelFor(
    rawThinkingLevel,
    "settings.defaultThinkingLevel",
  );

  const providers = asObject(modelsConfig.providers, "models.json.providers");
  const provider = asObject(
    providers[providerId],
    `models.json.providers.${providerId}`,
  );
  const providerApi = supportedApi(provider.api, "provider.api");
  if (!Array.isArray(provider.models)) {
    throw new Error("provider.models must be an array");
  }
  const rawModel = provider.models.find((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return (value as JsonObject).id === modelId;
  });
  if (!rawModel) {
    throw new Error(`Default model is not configured for provider ${providerId}`);
  }
  const modelConfig = asObject(rawModel, `model ${modelId}`);
  const modelApi =
    modelConfig.api === undefined
      ? providerApi
      : supportedApi(modelConfig.api, "model.api");

  const transport = options.transport ?? "sse";

  const command = options.apiKeyEnv === undefined
    ? trustedCommand(provider.apiKey)
    : undefined;
  const apiKeyEnv = options.apiKeyEnv === undefined
    ? undefined
    : validatedApiKeyEnvironmentName(options.apiKeyEnv);
  const rawCompat = mergedCompat(provider.compat, modelConfig.compat);
  const modelBase = {
    id: modelId,
    name:
      modelConfig.name === undefined
        ? modelId
        : asNonEmptyString(modelConfig.name, "model.name"),
    provider: providerId,
    baseUrl: validateBaseUrl(
      options.baseUrl ?? modelConfig.baseUrl ?? provider.baseUrl,
    ),
    reasoning: optionalBoolean(
      modelConfig.reasoning,
      false,
      "model.reasoning",
    ),
    input: optionalInput(modelConfig.input, "model.input"),
    cost: optionalCost(modelConfig.cost, "model.cost"),
    contextWindow: optionalPositiveInteger(
      modelConfig.contextWindow,
      128_000,
      "model.contextWindow",
    ),
    maxTokens: optionalPositiveInteger(
      modelConfig.maxTokens,
      16_384,
      "model.maxTokens",
    ),
  };
  let model: PiModel;
  if (modelApi === "openai-completions") {
    const compat = optionalCompletionsCompat(rawCompat);
    model = {
      ...modelBase,
      api: modelApi,
      ...(compat === undefined ? {} : { compat }),
    };
  } else {
    const compat = optionalResponsesCompat(rawCompat);
    model = {
      ...modelBase,
      api: modelApi,
      ...(compat === undefined ? {} : { compat }),
    };
  }

  const streamFn = streamFunctionFor(modelApi, transport);
  let apiKeyPromise: Promise<string> | undefined;
  const getApiKey = async (
    requestedProviderId: string,
  ): Promise<string | undefined> => {
    if (requestedProviderId !== providerId) return undefined;
    if (apiKeyEnv !== undefined) {
      const apiKey = process.env[apiKeyEnv]?.trim();
      if (!apiKey || apiKey.includes("\n") || apiKey.includes("\r")) {
        throw new Error("Configured API key environment variable is invalid");
      }
      return apiKey;
    }
    apiKeyPromise ??= executeTrustedApiKeyCommand(command!);
    return apiKeyPromise;
  };

  return {
    modelAdapterId: "configured-catalog",
    providerId,
    modelId,
    thinkingLevel,
    transport,
    model,
    streamFn,
    getApiKey,
  };
}
