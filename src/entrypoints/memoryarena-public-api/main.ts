import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  MEMORYARENA_PUBLIC_MEMORY_SYSTEM,
  MemoryArenaPublicError,
} from "../../benchmark/memoryarena-public/index.js";
import { createMemoryArenaPublicRuntime } from "../../benchmark/memoryarena-public/composition/create-runtime.js";
import {
  type PicorerInterfaceMode,
  type PicorerSkill,
} from "../../evidence-agent/index.js";
import {
  loadPiModelRuntime,
  type LoadPiModelRuntimeOptions,
  type PiModelRuntime,
} from "../../platform/pi/load-model-runtime.js";
import { OpenAICompatibleEmbedder } from "../../retrieval/adapters/openai/openai-compatible-embedder.js";
import { parseRetrievalProfile } from "../../retrieval/index.js";
import {
  MemoryArenaPublicApiService,
  MemoryArenaPublicApplication,
} from "./application.js";
import { memoryArenaHttpError } from "./http-errors.js";
import { createMemoryArenaRuntimeIdentity } from "./runtime-contract.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function thinkingLevelEnvironment(): NonNullable<
  LoadPiModelRuntimeOptions["thinkingLevel"]
> {
  const value = process.env.PICORER_THINKING_LEVEL?.trim() || "high";
  if (!new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).has(value)) {
    throw new Error("PICORER_THINKING_LEVEL is invalid");
  }
  return value as NonNullable<LoadPiModelRuntimeOptions["thinkingLevel"]>;
}

function skillEnvironment(): PicorerSkill {
  const value = process.env.PICORER_SKILL?.trim() || "picorer-v0";
  if (!new Set(["none", "picorer-minimal", "picorer-v0"]).has(value)) {
    throw new Error("PICORER_SKILL is invalid");
  }
  return value as PicorerSkill;
}

function interfaceModeEnvironment(skill: PicorerSkill): PicorerInterfaceMode {
  const fallback = skill === "picorer-minimal" ? "compact" : "full";
  const value = process.env.PICORER_INTERFACE_MODE?.trim() || fallback;
  if (!new Set(["full", "compact"]).has(value)) {
    throw new Error("PICORER_INTERFACE_MODE is invalid");
  }
  return value as PicorerInterfaceMode;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new MemoryArenaPublicError({
        code: "contract_error",
        message: "Request body exceeds 32 MiB",
        httpStatus: 422,
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new MemoryArenaPublicError({
      code: "contract_error",
      message: "Request body is required",
      httpStatus: 422,
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new MemoryArenaPublicError({
      code: "contract_error",
      message: "Request body must be valid JSON",
      httpStatus: 422,
    });
  }
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  retryable = false,
  errorCode?: string,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(errorCode === undefined
      ? {}
      : {
          "x-picorer-error-code": errorCode,
          "x-picorer-retryable": String(retryable),
        }),
    ...(retryable
      ? { "retry-after": "5" }
      : {}),
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function main(): Promise<void> {
  const dataDir = resolve(
    process.env.PICORER_DATA_DIR?.trim() || "./data/memoryarena-public",
  );
  const loadedModelRuntime = await loadPiModelRuntime({
    agentDir: resolve(
      process.env.PICORER_AGENT_DIR?.trim() || "./deploy/benchmark-agent-config",
    ),
    providerId:
      process.env.PICORER_PROVIDER?.trim() || "picorer-openai-responses",
    modelId: process.env.PICORER_MODEL?.trim() || "gpt-5.4-mini",
    thinkingLevel: thinkingLevelEnvironment(),
    baseUrl:
      process.env.OPENAI_API_BASE?.trim() ||
      requiredEnvironment("PICORER_AGENT_BASE_URL"),
    apiKeyEnv: process.env.PICORER_API_KEY_ENV?.trim() || "OPENAI_API_KEY",
    transport: process.env.PICORER_TRANSPORT?.trim() === "non-stream"
      ? "non-stream"
      : "sse",
  });
  const requestPolicy = {
    timeoutMs: integerEnvironment(
      "PICORER_REQUEST_TIMEOUT_MS",
      loadedModelRuntime.model.reasoning ? 120_000 : 90_000,
      1_800_000,
    ),
    maxRetries: 1,
    maxRetryDelayMs: 5_000,
  };
  const modelRuntime: PiModelRuntime = {
    ...loadedModelRuntime,
    requestPolicy,
    streamFn: (model, context, options) =>
      loadedModelRuntime.streamFn(model, context, {
        timeoutMs: requestPolicy.timeoutMs,
        maxRetries: requestPolicy.maxRetries,
        maxRetryDelayMs: requestPolicy.maxRetryDelayMs,
        ...options,
      }),
  };
  const embedder = OpenAICompatibleEmbedder.fromEnvironment();
  const retrievalProfile = parseRetrievalProfile(
    process.env.PICORER_RETRIEVAL_PROFILE,
  );
  if (retrievalProfile === "fts5") {
    throw new Error(
      "MemoryArena public API requires picorer-hybrid or picorer-hybrid-qdrant-hnsw-v1",
    );
  }
  const skill = skillEnvironment();
  const interfaceMode = interfaceModeEnvironment(skill);
  const maxRunMs = integerEnvironment("PICORER_MAX_RUN_MS", 300_000, 1_800_000);
  const maxTurns = integerEnvironment("PICORER_MAX_TURNS", 64, 256);
  const maxToolCalls = integerEnvironment("PICORER_MAX_TOOL_CALLS", 80, 512);
  const maxSearchCalls = integerEnvironment("PICORER_MAX_SEARCH_CALLS", 4, 16);
  const maximumConcurrentWraps = integerEnvironment(
    "PICORER_MAX_CONCURRENT_WRAPS",
    16,
    256,
  );
  const runtime = await createMemoryArenaPublicRuntime({
    dataDir,
    modelRuntime,
    embedder,
    memorySystemName:
      process.env.PICORER_MEMORY_SYSTEM_NAME?.trim() ||
      MEMORYARENA_PUBLIC_MEMORY_SYSTEM,
    skill,
    interfaceMode,
    maxRunMs,
    maxTurns,
    maxToolCalls,
    retrievalProfile,
  });
  const runtimeIdentity = createMemoryArenaRuntimeIdentity({
    sourceIdentity: requiredEnvironment("PICORER_SOURCE_IDENTITY"),
    buildIdentity: requiredEnvironment("PICORER_BUILD_IDENTITY"),
    skill,
    interfaceMode,
    modelRuntime,
    logicalModelId: requiredEnvironment("PICORER_LOGICAL_MODEL_ID"),
    protocol: requiredEnvironment("PICORER_RETRIEVAL_PROTOCOL"),
    baseUrl:
      process.env.OPENAI_API_BASE?.trim() ||
      requiredEnvironment("PICORER_AGENT_BASE_URL"),
    maxRunMs,
    maxTurns,
    maxToolCalls,
    maxSearchCalls,
    requestTimeoutMs: requestPolicy.timeoutMs,
    requestMaxRetries: requestPolicy.maxRetries,
    requestMaxRetryDelayMs: requestPolicy.maxRetryDelayMs,
    maxConcurrentWraps: maximumConcurrentWraps,
    ...(retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1"
      ? { memoryIndex: runtime.retrieval }
      : {}),
  });
  const expectedRuntimeIdentity = process.env
    .PICORER_EXPECTED_RUNTIME_IDENTITY_SHA256?.trim();
  if (
    expectedRuntimeIdentity !== undefined &&
    expectedRuntimeIdentity !== runtimeIdentity.sha256
  ) {
    throw new Error("Configured runtime identity does not match the service contract");
  }
  const service = new MemoryArenaPublicApiService(
    new MemoryArenaPublicApplication(runtime.backend, {
      maximumConcurrentWraps,
    }),
    runtimeIdentity,
    runtime.persistenceIdentity,
  );
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = integerEnvironment("PORT", 3111, 65_535);
  const server = createServer(async (request, response) => {
    const started = Date.now();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
      if (request.method === "GET" && path === "/health") {
        respond(response, 200, service.health());
        return;
      }
      if (request.method === "GET" && path === "/runtime") {
        respond(response, 200, service.runtime());
        return;
      }
      if (request.method !== "POST") {
        respond(response, 404, { detail: "Not Found" });
        return;
      }
      const body = await jsonBody(request);
      if (path === "/memory/initialize") {
        respond(response, 200, await service.initialize(body));
        return;
      }
      if (path === "/memory/add") {
        respond(response, 200, await service.add(body));
        return;
      }
      if (path === "/memory/wrap_user_prompt") {
        respond(response, 200, await service.wrap(body));
        return;
      }
      respond(response, 404, { detail: "Not Found" });
    } catch (error) {
      const failure = memoryArenaHttpError(error);
      respond(
        response,
        failure.status,
        failure.body,
        failure.retryable,
        failure.code,
      );
    } finally {
      const health = path === "/memory/wrap_user_prompt"
        ? service.health()
        : undefined;
      process.stderr.write(`${JSON.stringify({
        method: request.method,
        path,
        status: response.statusCode,
        duration_ms: Date.now() - started,
        ...(health === undefined ? {} : { load: health }),
      })}\n`);
    }
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(port, host, () => {
    process.stderr.write(`${JSON.stringify({
      event: "listening",
      service: "picorer-memoryarena-public",
      host,
      port,
      memory_system_name: runtime.memorySystemName,
      retrieval_skill: skill,
      runtime_identity_sha256: runtimeIdentity.sha256,
      data_dir: runtime.paths.root,
      load: service.health(),
    })}\n`);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Picorer MemoryArena Public API failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
