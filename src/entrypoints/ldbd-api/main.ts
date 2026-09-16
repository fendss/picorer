import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { loadPiModelRuntime } from "../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../platform/sqlite/picorer-store.js";
import { AsyncRequestGate } from "../../platform/concurrency/request-gate.js";
import { OpenAICompatibleEmbedder } from "../../retrieval/adapters/openai/openai-compatible-embedder.js";
import { parseRetrievalProfile } from "../../retrieval/index.js";
import { PicorerLdbdApplication } from "./picorer-runtime.js";
import {
  LdbdApiService,
  LdbdConflictError,
  LdbdContractError,
  LdbdUnavailableError,
} from "./service.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(request: IncomingMessage, expectedToken: string | undefined): boolean {
  if (expectedToken === undefined) return true;
  const authorization = request.headers.authorization?.trim() ?? "";
  const headerToken =
    authorization.match(/^(?:Token|Bearer)\s+(.+)$/iu)?.[1]?.trim() ??
    String(request.headers["x-api-key"] ?? "").trim();
  return headerToken !== "" && timingSafeEqual(tokenDigest(headerToken), tokenDigest(expectedToken));
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 2 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

const dataRoot = resolve(process.env.PICORER_DATA_DIR?.trim() || "./data/ldbd-api");
await mkdir(dataRoot, { recursive: true });
const store = await MemoryStore.create(join(dataRoot, "memory.sqlite"));
const embedder = OpenAICompatibleEmbedder.fromEnvironment();
const modelRuntime = await loadPiModelRuntime({
  agentDir: resolve(process.env.PICORER_AGENT_DIR?.trim() || "./deploy/agent-config"),
  providerId: process.env.PICORER_PROVIDER?.trim() || "picorer-openai",
  modelId: process.env.PICORER_MODEL?.trim() || "gpt-4o-mini",
  thinkingLevel: "off",
  baseUrl:
    process.env.OPENAI_API_BASE?.trim() ||
    requiredEnvironment("PICORER_AGENT_BASE_URL"),
  apiKeyEnv: "OPENAI_API_KEY",
  transport: process.env.PICORER_TRANSPORT?.trim() === "sse" ? "sse" : "non-stream",
});
const service = new LdbdApiService(
  new PicorerLdbdApplication(store, embedder, modelRuntime, {
    retrievalProfile: parseRetrievalProfile(
      process.env.PICORER_RETRIEVAL_PROFILE?.trim() || "picorer-hybrid",
    ),
  }),
);
const addGate = new AsyncRequestGate(8, 1_000);
const searchGate = new AsyncRequestGate(16, 1_000);
const expectedToken = process.env.PICORER_API_TOKEN?.trim() || undefined;
const port = integerEnvironment("PORT", 8787);
const host = process.env.HOST?.trim() || "0.0.0.0";

const server = createServer(async (request, response) => {
  const started = Date.now();
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      respond(response, 200, { status: "ok", service: "picorer-ldbd-api" });
      return;
    }
    if (!authorized(request, expectedToken)) {
      respond(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.method === "POST" && path === "/v1/memories/add") {
      respond(response, 200, await addGate.run(async () => service.add(await jsonBody(request))));
      return;
    }
    if (request.method === "POST" && path === "/v1/memories/search") {
      respond(response, 200, await searchGate.run(async () => service.search(await jsonBody(request))));
      return;
    }
    respond(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof LdbdContractError ? 422 :
      error instanceof LdbdConflictError ? 409 :
      error instanceof LdbdUnavailableError ? 503 : 500;
    respond(response, status, { error: message });
  } finally {
    process.stdout.write(`${JSON.stringify({ method: request.method, path, status: response.statusCode, duration_ms: Date.now() - started })}\n`);
  }
});

const shutdown = (): void => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: "listening", host, port })}\n`);
});
