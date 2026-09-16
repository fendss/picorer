import { requireEnvironmentVariable } from "../platform/security/protected-environment.js";
import type { MemoryStore } from "../platform/sqlite/picorer-store.js";
import {
  embeddingProfile,
  QdrantClient,
  QdrantDenseRetriever,
  QdrantVectorSynchronizer,
  type Embedder,
  type QdrantCollectionSpec,
  type VectorSearchConfiguration,
  type VectorIndexGenerationStatus,
} from "../retrieval/index.js";

function environmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export interface QdrantRetrievalConfiguration {
  generationId: string;
  collection: QdrantCollectionSpec;
  client: QdrantClient;
  requestTimeoutMs: number;
  hnswEf: number;
  syncBatchSize: number;
  syncConcurrency: number;
  verificationPollMs: number;
  verificationTimeoutMs: number;
}

/** Projects result-affecting Qdrant settings into the runtime identity. */
export function qdrantVectorSearchConfiguration(
  config: QdrantRetrievalConfiguration,
): VectorSearchConfiguration {
  return {
    algorithm: "qdrant-hnsw",
    hnswM: config.collection.hnsw.m,
    efConstruct: config.collection.hnsw.efConstruct,
    hnswEf: config.hnswEf,
    fullScanThresholdKb: config.collection.hnsw.fullScanThresholdKb,
    indexingThresholdKb: config.collection.indexingThresholdKb,
    exact: false,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

/** Resolves one pinned Qdrant generation without leaking environment into domains. */
export function qdrantRetrievalConfiguration(
  embedder: Embedder,
  environment: NodeJS.ProcessEnv = process.env,
): QdrantRetrievalConfiguration {
  const requestTimeoutMs = environmentInteger(
    environment,
    "PICORER_QDRANT_TIMEOUT_MS",
    120_000,
    600_000,
  );
  const collection: QdrantCollectionSpec = {
    name: environment.PICORER_QDRANT_COLLECTION?.trim() || "picorer_vectors_v1",
    dimensions: embedder.dimensions,
    indexingThresholdKb: environmentInteger(
      environment,
      "PICORER_QDRANT_INDEXING_THRESHOLD_KB",
      10_000,
      1_000_000_000,
    ),
    hnsw: {
      m: environmentInteger(environment, "PICORER_QDRANT_HNSW_M", 32, 256),
      efConstruct: environmentInteger(
        environment,
        "PICORER_QDRANT_EF_CONSTRUCT",
        200,
        10_000,
      ),
      fullScanThresholdKb: environmentInteger(
        environment,
        "PICORER_QDRANT_FULL_SCAN_THRESHOLD_KB",
        1_000,
        1_000_000_000,
      ),
    },
  };
  return {
    generationId: requireEnvironmentVariable(
      environment,
      "PICORER_VECTOR_GENERATION_ID",
    ),
    collection,
    client: new QdrantClient({
      baseUrl: requireEnvironmentVariable(environment, "PICORER_QDRANT_URL"),
      ...(environment.PICORER_QDRANT_API_KEY === undefined
        ? {}
        : { apiKey: environment.PICORER_QDRANT_API_KEY }),
      timeoutMs: requestTimeoutMs,
    }),
    requestTimeoutMs,
    hnswEf: environmentInteger(environment, "PICORER_QDRANT_HNSW_EF", 800, 10_000),
    syncBatchSize: environmentInteger(
      environment,
      "PICORER_QDRANT_SYNC_BATCH_SIZE",
      512,
      10_000,
    ),
    syncConcurrency: environmentInteger(
      environment,
      "PICORER_QDRANT_SYNC_CONCURRENCY",
      4,
      64,
    ),
    verificationPollMs: environmentInteger(
      environment,
      "PICORER_QDRANT_VERIFY_POLL_MS",
      1_000,
      60_000,
    ),
    verificationTimeoutMs: environmentInteger(
      environment,
      "PICORER_QDRANT_VERIFY_TIMEOUT_MS",
      3_600_000,
      86_400_000,
    ),
  };
}

export function createQdrantDenseRetriever(
  store: MemoryStore,
  embedder: Embedder,
  environment: NodeJS.ProcessEnv = process.env,
): QdrantDenseRetriever {
  const config = qdrantRetrievalConfiguration(embedder, environment);
  return new QdrantDenseRetriever({
    store,
    client: config.client,
    generationId: config.generationId,
    collectionName: config.collection.name,
    vectorSearch: qdrantVectorSearchConfiguration(config),
  });
}

/** Enqueues existing SQLite embeddings and atomically publishes a generation. */
export async function publishQdrantGeneration(
  store: MemoryStore,
  embedder: Embedder,
  scopeIds: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VectorIndexGenerationStatus> {
  const config = qdrantRetrievalConfiguration(embedder, environment);
  const profile = embeddingProfile(embedder);
  const requested = [...new Set(scopeIds)];
  if (requested.length === 0) {
    throw new Error("Cannot publish an empty Qdrant generation");
  }
  const corpusScopeIds = new Set(store.listScopeIds());
  for (const scopeId of requested) {
    if (!corpusScopeIds.has(scopeId)) {
      throw new Error(`Cannot publish missing Qdrant scope: ${scopeId}`);
    }
  }
  const initial = store.beginVectorIndexGeneration({
    generationId: config.generationId,
    collectionName: config.collection.name,
    profile,
  });
  if (initial.state === "ingesting") {
    for (const scopeId of requested) {
      store.enqueueStoredScopeEmbeddingsForVectorGeneration(
        config.generationId,
        scopeId,
        profile,
      );
    }
  } else {
    const published = new Map(
      store.listVectorGenerationScopeCounts(config.generationId)
        .map((item) => [item.scopeId, item.count]),
    );
    for (const scopeId of requested) {
      const expected = store.getEmbeddingIndexStatus(scopeId, profile);
      if (
        expected.missing !== 0 ||
        published.get(scopeId) !== expected.total
      ) {
        throw new Error(
          `Qdrant generation ${config.generationId} does not cover requested ` +
            `scope ${scopeId}; use a new PICORER_VECTOR_GENERATION_ID`,
        );
      }
    }
  }
  const synchronizer = new QdrantVectorSynchronizer({
    store,
    client: config.client,
    generationId: config.generationId,
    collection: config.collection,
    batchSize: config.syncBatchSize,
    concurrentBatches: config.syncConcurrency,
    verificationPollMs: config.verificationPollMs,
    verificationTimeoutMs: config.verificationTimeoutMs,
  });
  return synchronizer.finalize();
}
