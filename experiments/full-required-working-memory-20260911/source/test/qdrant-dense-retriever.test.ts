import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestMemorySessions } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import {
  DenseRetrievalError,
  deterministicQdrantPointId,
  QdrantHttpError,
  QdrantDenseRetriever,
  type EmbeddingProfile,
  type QdrantDenseSearchClient,
  type QdrantSearchHit,
  type QdrantSearchRequest,
} from "../src/retrieval/index.js";

const temporaryPaths: string[] = [];
const profile: EmbeddingProfile = {
  profileId: "profile-a",
  model: "embedding-a",
  dimensions: 2,
};

class CapturingClient implements QdrantDenseSearchClient {
  requests: QdrantSearchRequest[] = [];
  hits: QdrantSearchHit[] = [];
  error: unknown = undefined;

  search(request: QdrantSearchRequest): Promise<QdrantSearchHit[]> {
    this.requests.push(request);
    if (this.error !== undefined) return Promise.reject(this.error);
    return Promise.resolve(this.hits);
  }
}

async function fixture(ready: boolean): Promise<{
  store: MemoryStore;
  client: CapturingClient;
  retriever: QdrantDenseRetriever;
}> {
  const root = await mkdtemp(join(tmpdir(), "picorer-qdrant-dense-"));
  temporaryPaths.push(root);
  const store = await MemoryStore.create(join(root, "memory.sqlite"));
  await ingestMemorySessions(store, [{
    scopeId: "scope-a",
    sessionId: "session-a",
    timestamp: "2024-01-01T00:00:00.000Z",
    turns: [
      { id: "memory-a", role: "user", content: "alpha" },
      { id: "memory-b", role: "assistant", content: "beta" },
    ],
  }]);
  const records = store.listScopeRecords("scope-a");
  store.storeEmbeddingBatch(records, profile, [[1, 0], [0.8, 0.2]]);
  store.beginVectorIndexGeneration({
    generationId: "generation-a",
    collectionName: "picorer_vectors_v1",
    profile,
  });
  store.enqueueStoredScopeEmbeddingsForVectorGeneration(
    "generation-a",
    "scope-a",
    profile,
  );
  if (ready) {
    store.sealVectorIndexGeneration("generation-a");
    const claims = store.claimVectorSyncBatch("generation-a", 10, 1_000);
    store.completeVectorSyncBatch(
      "generation-a",
      claims.map((claim) => claim.sequenceId),
    );
    store.beginVectorIndexVerification("generation-a");
    store.markVectorIndexGenerationReady("generation-a", records.length);
  }
  const client = new CapturingClient();
  return {
    store,
    client,
    retriever: new QdrantDenseRetriever({
      store,
      client,
      generationId: "generation-a",
      collectionName: "picorer_vectors_v1",
      vectorSearch: {
        algorithm: "qdrant-hnsw",
        hnswM: 32,
        efConstruct: 200,
        hnswEf: 256,
        fullScanThresholdKb: 1_000,
        indexingThresholdKb: 10_000,
        exact: false,
        requestTimeoutMs: 90_000,
      },
    }),
  };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Qdrant dense retriever", () => {
  it("refuses incomplete generations", async () => {
    const { store, client, retriever } = await fixture(false);
    try {
      await expect(retriever.search({
        scopeId: "scope-a",
        profile,
        queryVectors: [[1, 0]],
        limit: 20,
      })).rejects.toThrow(/not ready/u);
      expect(client.requests).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("hydrates ordered records and revalidates provenance", async () => {
    const { store, client, retriever } = await fixture(true);
    try {
      const [memoryA, memoryB] = store.listScopeRecords("scope-a");
      const hit = (record: typeof memoryA, score: number): QdrantSearchHit => ({
        pointId: deterministicQdrantPointId(
          "generation-a",
          record!.scopeId,
          record!.memoryId,
          profile.profileId,
        ),
        score,
        generationId: "generation-a",
        scopeId: record!.scopeId,
        memoryId: record!.memoryId,
        sessionId: record!.sessionId,
        role: record!.role,
        ...(record!.timestamp === undefined ? {} : { timestamp: record!.timestamp }),
        profileId: profile.profileId,
        contentHash: record!.contentHash,
        schemaVersion: 2,
      });
      client.hits = [hit(memoryB, 0.8), hit(memoryA, 0.9)];
      const results = await retriever.search({
        scopeId: "scope-a",
        profile,
        queryVectors: [[1, 0]],
        limit: 20,
        filters: { roles: ["user", "assistant"] },
      });
      expect(results[0]?.map((item) => item.record.memoryId))
        .toEqual(["memory-a", "memory-b"]);
      expect(client.requests[0]).toMatchObject({
        generationId: "generation-a",
        scopeId: "scope-a",
        roles: ["user", "assistant"],
        hnswEf: 256,
      });
      expect(retriever.vectorSearch).toMatchObject({
        hnswEf: 256,
        requestTimeoutMs: 90_000,
      });

      client.hits = [{ ...hit(memoryA, 0.9), contentHash: "wrong" }];
      await expect(retriever.search({
        scopeId: "scope-a",
        profile,
        queryVectors: [[1, 0]],
        limit: 20,
      })).rejects.toThrow(/provenance mismatch/u);
    } finally {
      store.close();
    }
  });

  it("classifies transport failures without making integrity errors retryable", async () => {
    const { store, client, retriever } = await fixture(true);
    const request = {
      scopeId: "scope-a",
      profile,
      queryVectors: [[1, 0]],
      limit: 20,
    };
    try {
      client.error = new QdrantHttpError(503, "busy");
      await expect(retriever.search(request)).rejects.toMatchObject({
        kind: "unavailable",
      } satisfies Partial<DenseRetrievalError>);

      client.error = new QdrantHttpError(401, "unauthorized");
      await expect(retriever.search(request)).rejects.toMatchObject({
        kind: "configuration",
      } satisfies Partial<DenseRetrievalError>);

      client.error = new Error("malformed response");
      await expect(retriever.search(request)).rejects.toMatchObject({
        kind: "integrity",
      } satisfies Partial<DenseRetrievalError>);
    } finally {
      store.close();
    }
  });

  it("fails closed when a ready generation does not cover a later scope", async () => {
    const { store, client, retriever } = await fixture(true);
    try {
      await ingestMemorySessions(store, [{
        scopeId: "scope-b",
        sessionId: "session-b",
        turns: [{ id: "memory-c", role: "user", content: "gamma" }],
      }]);
      store.storeEmbeddingBatch(
        store.listScopeRecords("scope-b"),
        profile,
        [[0, 1]],
      );
      await expect(retriever.search({
        scopeId: "scope-b",
        profile,
        queryVectors: [[0, 1]],
        limit: 20,
      })).rejects.toThrow(/does not cover scope scope-b/u);
      expect(client.requests).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
