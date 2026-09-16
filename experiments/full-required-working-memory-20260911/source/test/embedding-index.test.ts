import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Embedder,
  EmbeddingMetrics,
  EmbeddingRequestOptions,
} from "../src/retrieval/index.js";
import {
  embeddingProfile,
  indexScopeEmbeddings,
} from "../src/retrieval/index.js";
import { ingestMemorySessions } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";

const temporaryPaths: string[] = [];

class FakeEmbedder implements Embedder {
  readonly profileId = "test-profile";
  readonly model = "test-embedding";
  readonly dimensions = 2;
  readonly maxInputLength = 2048;
  readonly batchSize = 1;
  readonly inputs: string[] = [];

  embedDocuments(
    texts: readonly string[],
    _options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    this.inputs.push(...texts);
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  embedQueries(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => [text.length, 1]));
  }

  snapshotMetrics(): EmbeddingMetrics {
    return { calls: this.inputs.length, latencyMs: 0 };
  }
}

async function createStore(): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "picorer-embedding-index-"));
  temporaryPaths.push(root);
  const store = await MemoryStore.create(join(root, "memory.sqlite"));
  await ingestMemorySessions(store, [
    {
      scopeId: "scope-1",
      sessionId: "session-1",
      timestamp: "2024-01-01T00:00:00",
      turns: [
        { id: "m1", role: "user", content: "alpha" },
        { id: "m2", role: "assistant", content: "beta" },
      ],
    },
  ]);
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("derived embedding index", () => {
  it("resumes a partial index and makes a complete rerun a no-op", async () => {
    const store = await createStore();
    const embedder = new FakeEmbedder();
    try {
      const records = store.listScopeRecords("scope-1");
      store.storeEmbeddingBatch(
        [records[0]!],
        embeddingProfile(embedder),
        [[5, 1]],
      );

      const first = await indexScopeEmbeddings(store, "scope-1", embedder);
      expect(first).toMatchObject({
        total: 2,
        indexed: 2,
        missing: 0,
        indexedNow: 1,
        skipped: 1,
      });
      expect(embedder.inputs).toEqual(["assistant: beta"]);

      embedder.inputs.length = 0;
      const second = await indexScopeEmbeddings(store, "scope-1", embedder);
      expect(second).toMatchObject({ indexedNow: 0, skipped: 2, missing: 0 });
      expect(embedder.inputs).toEqual([]);
      expect(store.listScopeRecords("scope-1").map((record) => record.content))
        .toEqual(["alpha", "beta"]);
    } finally {
      store.close();
    }
  });

  it("treats an identical direct re-index as unchanged", async () => {
    const store = await createStore();
    const embedder = new FakeEmbedder();
    try {
      const record = store.listScopeRecords("scope-1")[0]!;
      const profile = embeddingProfile(embedder);
      expect(store.storeEmbeddingBatch([record], profile, [[1.25, -2.5]]))
        .toEqual({ inserted: 1, unchanged: 0 });
      expect(store.storeEmbeddingBatch([record], profile, [[1.25, -2.5]]))
        .toEqual({ inserted: 0, unchanged: 1 });
      expect(store.listStoredEmbeddings("scope-1", profile)[0]?.vector)
        .toEqual(new Float32Array([1.25, -2.5]));
    } finally {
      store.close();
    }
  });

  it("caches complete scope status without exposing mutable cache state", async () => {
    const store = await createStore();
    const embedder = new FakeEmbedder();
    try {
      await indexScopeEmbeddings(store, "scope-1", embedder);
      const first = store.getEmbeddingIndexStatus(
        "scope-1",
        embeddingProfile(embedder),
      );
      first.indexed = 0;
      first.missing = 2;

      expect(store.getEmbeddingIndexStatus(
        "scope-1",
        embeddingProfile(embedder),
      )).toMatchObject({ total: 2, indexed: 2, missing: 0 });
    } finally {
      store.close();
    }
  });

  it("keeps full index scans out of the per-batch write path", async () => {
    const store = await createStore();
    const embedder = new FakeEmbedder();
    try {
      const records = store.listScopeRecords("scope-1");
      const profile = embeddingProfile(embedder);
      const status = vi.spyOn(store, "getEmbeddingIndexStatus");

      expect(store.storeEmbeddingBatch([records[0]!], profile, [[1, 2]]))
        .toEqual({ inserted: 1, unchanged: 0 });
      expect(status).not.toHaveBeenCalled();
      expect(() => store.storeEmbeddingBatch(
        [records[1]!],
        { ...profile, model: "different-model" },
        [[1, 2]],
      )).toThrow(/profile metadata conflict/u);
    } finally {
      store.close();
    }
  });

  it("rejects invalid dimensions, non-finite vectors, and content mismatches", async () => {
    const store = await createStore();
    const embedder = new FakeEmbedder();
    try {
      const record = store.listScopeRecords("scope-1")[0]!;
      const profile = embeddingProfile(embedder);
      expect(() => store.storeEmbeddingBatch([record], profile, [[1]]))
        .toThrow(/2 dimensions/u);
      expect(() => store.storeEmbeddingBatch([record], profile, [[1, Infinity]]))
        .toThrow(/non-finite/u);
      expect(() => store.storeEmbeddingBatch(
        [{ ...record, contentHash: "wrong" }],
        profile,
        [[1, 2]],
      )).toThrow(/content hash mismatch/u);
      expect(store.getEmbeddingIndexStatus("scope-1", profile).missing).toBe(2);
    } finally {
      store.close();
    }
  });
});
