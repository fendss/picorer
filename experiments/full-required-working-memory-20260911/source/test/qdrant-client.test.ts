import { describe, expect, it, vi } from "vitest";
import {
  QdrantClient,
} from "../src/retrieval/index.js";

function response(status: number, value: unknown): Response {
  return new Response(
    value === undefined ? undefined : JSON.stringify(value),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("Qdrant HTTP adapter", () => {
  it("rejects unsafe endpoints and preserves HTTP status", async () => {
    expect(() => new QdrantClient({ baseUrl: "file:///tmp/qdrant" }))
      .toThrow(/HTTP or HTTPS/u);
    expect(() => new QdrantClient({ baseUrl: "http://user:pass@qdrant/" }))
      .toThrow(/credentials/u);
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333",
      fetchImpl: vi.fn(async () => response(503, { status: "busy" })),
    });
    await expect(client.getCollection("picorer_vectors_v1"))
      .rejects.toMatchObject({ status: 503 });
  });

  it("creates a pinned collection and every mandatory payload index", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let created = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      const body = init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as unknown;
      requests.push({ method: init?.method ?? "GET", path, ...(body === undefined ? {} : { body }) });
      if (path === "/collections/picorer_vectors_v1" && init?.method === "GET") {
        if (!created) return response(404, { status: "not found" });
        return response(200, {
          result: {
            status: "green",
            optimizer_status: "ok",
            segments_count: 0,
            points_count: 0,
            indexed_vectors_count: 0,
            config: {
              params: { vectors: { size: 2, distance: "Cosine" } },
              hnsw_config: {
                m: 32,
                ef_construct: 200,
                full_scan_threshold: 1_000,
              },
              optimizer_config: { indexing_threshold: 10_000 },
            },
          },
        });
      }
      if (path === "/collections/picorer_vectors_v1" && init?.method === "PUT") {
        created = true;
      }
      return response(200, { status: "ok", result: true });
    });
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333",
      fetchImpl,
    });
    await client.ensureCollection({
      name: "picorer_vectors_v1",
      dimensions: 2,
      indexingThresholdKb: 10_000,
      hnsw: { m: 32, efConstruct: 200, fullScanThresholdKb: 1_000 },
    });
    expect(requests.filter((item) => item.path.endsWith("/index?wait=true")))
      .toHaveLength(7);
    expect(requests.map((item) => item.body)).toContainEqual({
      field_name: "scope_id",
      field_schema: { type: "keyword", is_tenant: true },
    });
  });

  it("treats a concurrent collection-create conflict as an idempotent race", async () => {
    let collectionReads = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      if (path === "/collections/picorer_vectors_v1" && init?.method === "GET") {
        collectionReads += 1;
        if (collectionReads === 1) return response(404, { status: "not found" });
        return response(200, {
          result: {
            status: "green",
            optimizer_status: "ok",
            segments_count: 0,
            points_count: 0,
            indexed_vectors_count: 0,
            config: {
              params: { vectors: { size: 2, distance: "Cosine" } },
              hnsw_config: {
                m: 32,
                ef_construct: 200,
                full_scan_threshold: 1_000,
              },
              optimizer_config: { indexing_threshold: 10_000 },
            },
          },
        });
      }
      if (path === "/collections/picorer_vectors_v1" && init?.method === "PUT") {
        return response(409, { status: { error: "collection already exists" } });
      }
      return response(200, { status: "ok", result: true });
    });
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333",
      fetchImpl,
    });

    await expect(client.ensureCollection({
      name: "picorer_vectors_v1",
      dimensions: 2,
      indexingThresholdKb: 10_000,
      hnsw: { m: 32, efConstruct: 200, fullScanThresholdKb: 1_000 },
    })).resolves.toBeUndefined();
    expect(collectionReads).toBe(2);
  });

  it("sends mandatory generation, scope, profile, and metadata filters", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("api-key")).toBe("secret-a");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        query: [1, 0],
        params: { hnsw_ef: 512, exact: false },
        limit: 20,
        with_vector: false,
        filter: {
          must: expect.arrayContaining([
            { key: "schema_version", match: { value: 2 } },
            { key: "generation_id", match: { value: "generation-a" } },
            { key: "scope_id", match: { value: "scope-a" } },
            { key: "profile_id", match: { value: "profile-a" } },
            { key: "session_id", match: { any: ["session-a"] } },
            { key: "role", match: { any: ["user"] } },
            {
              key: "timestamp",
              range: { gte: "2024-01-01", lte: "2024-12-31" },
            },
          ]),
        },
      });
      return response(200, {
        result: {
          points: [{
            id: "point-a",
            score: 0.9,
            payload: {
              generation_id: "generation-a",
              scope_id: "scope-a",
              memory_id: "memory-a",
              session_id: "session-a",
              role: "user",
              timestamp: "2024-06-01",
              profile_id: "profile-a",
              content_hash: "hash-a",
              schema_version: 2,
            },
          }],
        },
      });
    });
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333/",
      apiKey: "secret-a",
      fetchImpl,
    });
    const hits = await client.search({
      collection: "picorer_vectors_v1",
      vector: [1, 0],
      generationId: "generation-a",
      scopeId: "scope-a",
      profileId: "profile-a",
      sessionIds: ["session-a"],
      roles: ["user"],
      after: "2024-01-01",
      before: "2024-12-31",
      limit: 20,
      hnswEf: 512,
    });
    expect(hits).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]?.[0]).endsWith(
      "/collections/picorer_vectors_v1/points/query",
    )).toBe(true);
  });

  it("fails closed when Qdrant violates a mandatory filter", async () => {
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333",
      fetchImpl: vi.fn(async () => response(200, {
        result: {
          points: [{
            id: "point-a",
            score: 0.9,
            payload: {
              generation_id: "generation-a",
              scope_id: "scope-b",
              memory_id: "memory-a",
              session_id: "session-a",
              role: "user",
              profile_id: "profile-a",
              content_hash: "hash-a",
              schema_version: 2,
            },
          }],
        },
      })),
    });
    await expect(client.search({
      collection: "picorer_vectors_v1",
      vector: [1, 0],
      generationId: "generation-a",
      scopeId: "scope-a",
      profileId: "profile-a",
      limit: 20,
      hnswEf: 512,
    })).rejects.toThrow(/mandatory filter/u);
  });

  it("revalidates datetime filters by instant instead of string order", async () => {
    const client = new QdrantClient({
      baseUrl: "http://qdrant.internal:6333",
      fetchImpl: vi.fn(async () => response(200, {
        result: {
          points: [{
            id: "point-a",
            score: 0.9,
            payload: {
              generation_id: "generation-a",
              scope_id: "scope-a",
              memory_id: "memory-a",
              session_id: "session-a",
              role: "user",
              timestamp: "2023-12-31T17:00:00Z",
              profile_id: "profile-a",
              content_hash: "hash-a",
              schema_version: 2,
            },
          }],
        },
      })),
    });
    await expect(client.search({
      collection: "picorer_vectors_v1",
      vector: [1, 0],
      generationId: "generation-a",
      scopeId: "scope-a",
      profileId: "profile-a",
      after: "2024-01-01T00:00:00+08:00",
      limit: 20,
      hnswEf: 512,
    })).resolves.toHaveLength(1);
  });
});
