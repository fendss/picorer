import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMemoryArenaGenerationStore } from "../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.js";
import {
  MemoryArenaPublicMemoryBackend,
  type MemoryArenaChunkMemory,
  type MemoryArenaCommittedEvidence,
  type MemoryArenaEmbeddingOperationMeter,
  type MemoryArenaEvidenceRetriever,
  type MemoryArenaOriginalChunk,
  type MemoryArenaOperationAuditSink,
} from "../src/benchmark/memoryarena-public/index.js";
import {
  MemoryArenaPublicApiService,
  MemoryArenaPublicApplication,
} from "../src/entrypoints/memoryarena-public-api/application.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NOOP_OPERATION_AUDITS: MemoryArenaOperationAuditSink = {
  begin: async () => ({
    succeed: async () => undefined,
    fail: async () => undefined,
  }),
};
const NOOP_EMBEDDING_METER: MemoryArenaEmbeddingOperationMeter = {
  measureOperation: async (operation) => ({
    result: await operation(),
    embedding: {
      measurement: "async_context",
      delta: { calls: 0, latencyMs: 0, inputTokens: 0, usageMissingCalls: 0 },
    },
  }),
};

function exactEvidence(
  memoryId: string,
  content: string,
): MemoryArenaCommittedEvidence {
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    memoryId,
    scopeId: "test-scope",
    sessionId: memoryId,
    turnIndex: 0,
    role: "other",
    content,
    contentHash,
    sourceContentHash: contentHash,
    sourceContentLength: content.length,
    truncated: false,
    excerpts: [{ start: 0, end: content.length, content }],
    metadata: {},
  };
}

class InMemoryChunks implements MemoryArenaChunkMemory {
  readonly appends: Array<{
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }> = [];
  private readonly chunks = new Map<string, string>();

  async appendOriginalChunk(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }): Promise<void> {
    this.appends.push({ ...options });
    this.chunks.set(`m-${options.generation}-${options.ordinal}`, options.chunk);
  }

  async readOriginalChunks(options: {
    memoryIds: readonly string[];
  }): Promise<MemoryArenaOriginalChunk[]> {
    return options.memoryIds.flatMap((memoryId) => {
      const content = this.chunks.get(memoryId);
      return content === undefined ? [] : [{ memoryId, content }];
    });
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>(
    (done, reject) => server.close((error) => error ? reject(error) : done()),
  )));
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function startHttpGateway(
  service: MemoryArenaPublicApiService,
): Promise<string> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const result = path === "/memory/initialize"
        ? await service.initialize(body)
        : path === "/memory/add"
          ? await service.add(body)
          : path === "/memory/wrap_user_prompt"
            ? await service.wrap(body)
            : undefined;
      if (result === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"detail":"Not Found"}\n');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(result)}\n`);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        detail: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("MemoryArena test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("MemoryArena Public official-client HTTP seam", () => {
  it("runs initialize -> empty wrap -> add -> wrap -> add -> wrap offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "picorer-memoryarena-http-"));
    temporaryDirectories.push(directory);
    const chunks = new InMemoryChunks();
    const retriever: MemoryArenaEvidenceRetriever = {
      retrieve: vi.fn(async () => chunks.appends.length === 1
        ? {
            runId: "run-1",
            status: "sufficient" as const,
            citations: [{ memoryId: "m-1-0", supports: "first" }],
            evidenceSummary: "The first exact passage answers the question.",
            evidence: [exactEvidence("m-1-0", "first raw chunk")],
            trace: [],
            usage: ZERO_USAGE,
          }
        : {
            runId: "run-2",
            status: "sufficient" as const,
            citations: [
              { memoryId: "m-1-1", supports: "latest" },
              { memoryId: "m-1-0", supports: "prior" },
            ],
            inventory: [{ item: "history", memoryIds: ["m-1-0"] }],
            evidenceSummary: "The second passage changed after the first.",
            evidence: [
              exactEvidence("m-1-1", "second <raw> chunk"),
              exactEvidence("m-1-0", "first raw chunk"),
            ],
            trace: [],
            usage: ZERO_USAGE,
          }),
    };
    const backend = new MemoryArenaPublicMemoryBackend({
      generations: new FileMemoryArenaGenerationStore(
        join(directory, "active-generations.json"),
      ),
      chunks,
      retriever,
      audits: { record: async () => undefined },
      operationAudits: NOOP_OPERATION_AUDITS,
      embeddingMeter: NOOP_EMBEDDING_METER,
      memorySystemName: "picorer",
    });
    const baseUrl = await startHttpGateway(new MemoryArenaPublicApiService(
      new MemoryArenaPublicApplication(backend),
    ));

    const { stdout, stderr } = await executeFile(
      "python3",
      [
        resolve(
          "integrations/memoryarena-public/tests/test_official_client_compat.py",
        ),
        "--exercise-server",
        baseUrl,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      empty: "<memory_context>\nNone\n</memory_context>\nUser: Empty?",
      first_add: {
        status: "ok",
        user_id: "official-client-e2e",
        response: null,
      },
      after_first: [
        "<memory_context>",
        "<memory>first raw chunk</memory>",
        "</memory_context>",
        "User: What is first?",
      ].join("\n"),
      second_add: {
        status: "ok",
        user_id: "official-client-e2e",
        response: null,
      },
      after_second: [
        "<memory_context>",
        "<memory>second <raw> chunk</memory>",
        "<memory>first raw chunk</memory>",
        "</memory_context>",
        "User: What changed?",
      ].join("\n"),
    });
    expect(chunks.appends).toEqual([
      {
        userId: "official-client-e2e",
        generation: 1,
        ordinal: 0,
        chunk: "first raw chunk",
      },
      {
        userId: "official-client-e2e",
        generation: 1,
        ordinal: 1,
        chunk: "second <raw> chunk",
      },
    ]);
    expect(retriever.retrieve).toHaveBeenCalledTimes(2);
  });
});
