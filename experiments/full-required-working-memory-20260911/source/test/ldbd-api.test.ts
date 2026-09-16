import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAddRequest,
  parseSearchRequest,
  renderRetrievalQuestion,
} from "../src/entrypoints/ldbd-api/contracts.js";
import {
  LdbdApiService,
  onlineScopeId,
} from "../src/entrypoints/ldbd-api/service.js";
import { PicorerLdbdApplication } from "../src/entrypoints/ldbd-api/picorer-runtime.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import type { Embedder } from "../src/retrieval/index.js";
import { sha256 } from "../src/util.js";

const temporaryDirectories: string[] = [];

async function memoryStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-ldbd-api-"));
  temporaryDirectories.push(directory);
  return MemoryStore.create(join(directory, "memory.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LDBD API contracts", () => {
  it("accepts the exact Add contract without rewriting raw content", () => {
    expect(parseAddRequest({
      request_id: "request-1",
      user_id: "user-1",
      session_id: "session-1",
      messages: [{ role: "user", content: "  exact content  ", timestamp: 1_704_067_200_000 }],
    })).toEqual({
      requestId: "request-1",
      userId: "user-1",
      sessionId: "session-1",
      messages: [{ role: "user", content: "  exact content  ", timestamp: 1_704_067_200_000 }],
    });
  });

  it("rejects malformed and extra benchmark fields", () => {
    expect(() => parseAddRequest({})).toThrow("messages must be a non-empty array");
    expect(() => parseAddRequest({
      request_id: "r", user_id: "u", session_id: "s",
      messages: [{ role: "user", content: "m" }], answer: "gold",
    })).toThrow("unsupported fields");
    expect(() => parseSearchRequest({})).toThrow("top_k must be an integer");
  });

  it("adds benchmark options only to the retrieval question", () => {
    const request = parseSearchRequest({
      query: "Which preference applies?",
      user_id: "user-1",
      top_k: 100,
      options: ["first", "second"],
    });
    expect(renderRetrievalQuestion(request)).toContain("- first\n- second");
  });
});

describe("online memory persistence", () => {
  it("appends idempotently with stable scope/session IDs and seals against later Add", async () => {
    const store = await memoryStore();
    const scopeId = onlineScopeId("user-1");
    const request = {
      requestId: "request-1",
      requestHash: sha256("payload-1"),
      scopeId,
      sourceSessionId: "session-1",
      messages: [{ role: "assistant" as const, content: "stored memory" }],
    };
    expect(store.appendMemoryRequest(request).status).toBe("pending");
    store.markAppendRequestComplete(request.requestId, request.requestHash);
    expect(store.appendMemoryRequest(request).status).toBe("complete");
    expect(store.listScopeRecords(scopeId)).toHaveLength(1);
    expect(store.sealOnlineScope(scopeId)).toBe("sealed");
    expect(() => store.appendMemoryRequest({
      ...request,
      requestId: "request-2",
      requestHash: sha256("payload-2"),
    })).toThrow("sealed");
    store.close();
  });

  it("adopts a legacy immutable scope as sealed without rewriting memories", async () => {
    const store = await memoryStore();
    const scopeId = onlineScopeId("legacy-user");
    store.ingestScope(scopeId, [{
      memoryId: "legacy-memory",
      scopeId,
      sessionId: "legacy-session",
      turnIndex: 0,
      role: "user",
      content: "legacy content",
      contentHash: sha256("legacy content"),
      metadata: {},
    }]);
    expect(store.getOnlineScopeState(scopeId)).toBeUndefined();
    expect(store.sealOnlineScope(scopeId)).toBe("sealed");
    expect(store.getOnlineScopeState(scopeId)).toBe("sealed");
    expect(store.listScopeRecords(scopeId).map((record) => record.content))
      .toEqual(["legacy content"]);
    store.close();
  });

  it("rejects request ID conflicts and sealing with pending indexing", async () => {
    const store = await memoryStore();
    const scopeId = onlineScopeId("user-1");
    const request = {
      requestId: "request-1",
      requestHash: sha256("payload-1"),
      scopeId,
      sourceSessionId: "session-1",
      messages: [{ role: "user" as const, content: "memory" }],
    };
    store.appendMemoryRequest(request);
    expect(() => store.appendMemoryRequest({ ...request, requestHash: sha256("different") }))
      .toThrow("conflict");
    expect(() => store.sealOnlineScope(scopeId)).toThrow("incomplete");
    store.close();
  });
});

describe("LDBD service", () => {
  it("returns exact response envelopes through the application port", async () => {
    const add = vi.fn(async () => "inserted" as const);
    const search = vi.fn(async () => [{ id: "memory-1", content: "evidence" }]);
    const service = new LdbdApiService({ add, search });
    await expect(service.add({
      request_id: "request-1",
      user_id: "user-1",
      session_id: "session-1",
      messages: [{ role: "user", content: "memory" }],
    })).resolves.toMatchObject({ success: true, status: "inserted" });
    await expect(service.search({ query: "question", user_id: "user-1", top_k: 100 }))
      .resolves.toEqual({ data: [{ id: "memory-1", content: "evidence" }] });
  });

  it("selects retrieval infrastructure without changing the Add contract", async () => {
    const store = await memoryStore();
    const embedDocuments = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => [1, 0])
    );
    const embedder: Embedder = {
      profileId: "profile-a",
      model: "embedding-a",
      dimensions: 2,
      maxInputLength: 2_048,
      batchSize: 32,
      embedDocuments,
      embedQueries: async (texts) => texts.map(() => [1, 0]),
      snapshotMetrics: () => ({ calls: 0, latencyMs: 0 }),
    };
    const modelRuntime = {} as PiModelRuntime;
    try {
      const fts = new PicorerLdbdApplication(store, embedder, modelRuntime, {
        retrievalProfile: "fts5",
        environment: {},
      });
      await expect(fts.add({
        requestId: "request-fts",
        userId: "user-fts",
        sessionId: "session-fts",
        messages: [{ role: "user", content: "exact memory" }],
      })).resolves.toBe("inserted");
      expect(embedDocuments).not.toHaveBeenCalled();

      const controller = new AbortController();
      const cancellation = new Error("cancel before scope sealing");
      controller.abort(cancellation);
      await expect(fts.search({
        query: "exact memory", userId: "user-fts", topK: 10, options: [],
      }, controller.signal)).rejects.toBe(cancellation);
      await expect(fts.add({
        requestId: "request-after-cancellation",
        userId: "user-fts",
        sessionId: "session-fts",
        messages: [{ role: "user", content: "scope is still writable" }],
      })).resolves.toBe("inserted");

      expect(() => new PicorerLdbdApplication(store, embedder, modelRuntime, {
        retrievalProfile: "picorer-hybrid-qdrant-hnsw-v1",
        environment: { PICORER_VECTOR_GENERATION_ID: "run-a" },
      })).toThrow(/PICORER_QDRANT_URL/u);
    } finally {
      store.close();
    }
  });
});
