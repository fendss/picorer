import type { MemoryRecord } from "../../../memory/index.js";
import type {
  EmbeddingIndexStatus,
  EmbeddingProfile,
  VectorIndexGenerationStatus,
} from "../../model/embedding.js";
import type {
  VectorSearchConfiguration,
} from "../../model/search.js";
import type {
  DenseRetriever,
  DenseSearchBatchRequest,
  DenseSearchHit,
} from "../../ports/dense-retriever.js";
import { DenseRetrievalError } from "../../ports/dense-retriever.js";
import type {
  QdrantSearchHit,
  QdrantSearchRequest,
} from "./client.js";
import {
  QDRANT_COLLECTION_SCHEMA_VERSION,
  QdrantHttpError,
} from "./client.js";
import { deterministicQdrantPointId } from "./vector-synchronizer.js";

export interface QdrantDenseSearchClient {
  search(request: QdrantSearchRequest): Promise<QdrantSearchHit[]>;
}

export interface QdrantDenseMetadataStore {
  assertVectorIndexGenerationReady(
    generationId: string,
  ): VectorIndexGenerationStatus | Promise<VectorIndexGenerationStatus>;
  getEmbeddingIndexStatus(
    scopeId: string,
    profile: EmbeddingProfile,
  ): EmbeddingIndexStatus | Promise<EmbeddingIndexStatus>;
  getVectorGenerationScopeCount(
    generationId: string,
    scopeId: string,
  ): number | Promise<number>;
  getRecords(
    scopeId: string,
    memoryIds: string[],
  ): MemoryRecord[] | Promise<MemoryRecord[]>;
}

export interface QdrantDenseRetrieverOptions {
  store: QdrantDenseMetadataStore;
  client: QdrantDenseSearchClient;
  generationId: string;
  collectionName: string;
  vectorSearch: VectorSearchConfiguration;
}

function qdrantSearchFailure(
  error: unknown,
  callerAborted: boolean,
): unknown {
  if (callerAborted) return error;
  if (error instanceof QdrantHttpError) {
    const unavailable = error.status === 408 || error.status === 429 ||
      error.status >= 500;
    return new DenseRetrievalError(
      unavailable ? "unavailable" : "configuration",
      `Qdrant search returned HTTP ${String(error.status)}`,
      { cause: error },
    );
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    return new DenseRetrievalError(
      "unavailable",
      "Qdrant search transport is unavailable",
      { cause: error },
    );
  }
  return new DenseRetrievalError(
    "integrity",
    "Qdrant search response failed validation",
    { cause: error },
  );
}

/** Filtered HNSW whose IDs and immutable provenance are revalidated in SQLite. */
export class QdrantDenseRetriever implements DenseRetriever {
  readonly retrievalProfile = "picorer-hybrid-qdrant-hnsw-v1" as const;
  readonly vectorGenerationId: string;
  readonly vectorCollection: string;
  readonly vectorSearch;
  private readonly hnswEf: number;

  constructor(private readonly options: QdrantDenseRetrieverOptions) {
    if (!options.generationId.trim() || !options.collectionName.trim()) {
      throw new Error("Qdrant generation and collection must not be empty");
    }
    this.hnswEf = options.vectorSearch.hnswEf;
    if (!Number.isSafeInteger(this.hnswEf) || this.hnswEf < 1 || this.hnswEf > 10_000) {
      throw new Error("Qdrant HNSW ef must be between 1 and 10000");
    }
    this.vectorGenerationId = options.generationId;
    this.vectorCollection = options.collectionName;
    const requestTimeoutMs = options.vectorSearch.requestTimeoutMs;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 600_000
    ) {
      throw new Error("Qdrant request timeout must be between 1 and 600000");
    }
    this.vectorSearch = structuredClone(options.vectorSearch);
  }

  private async hydrate(
    scopeId: string,
    hits: readonly QdrantSearchHit[],
    limit: number,
  ): Promise<DenseSearchHit[]> {
    if (new Set(hits.map((hit) => hit.memoryId)).size !== hits.length) {
      throw new DenseRetrievalError(
        "integrity",
        "Qdrant results contain duplicate memory IDs",
      );
    }
    const records = new Map(
      (await this.options.store.getRecords(
        scopeId,
        hits.map((hit) => hit.memoryId),
      )).map((record) => [record.memoryId, record]),
    );
    return hits.map((hit) => {
      const record = records.get(hit.memoryId);
      if (record === undefined) {
        throw new DenseRetrievalError(
          "integrity",
          `Qdrant returned missing scoped memory: ${hit.memoryId}`,
        );
      }
      if (
        hit.pointId !== deterministicQdrantPointId(
          hit.generationId,
          scopeId,
          hit.memoryId,
          hit.profileId,
        ) ||
        hit.schemaVersion !== QDRANT_COLLECTION_SCHEMA_VERSION ||
        hit.contentHash !== record.contentHash ||
        hit.sessionId !== record.sessionId ||
        hit.role !== record.role ||
        hit.timestamp !== record.timestamp
      ) {
        throw new DenseRetrievalError(
          "integrity",
          `Qdrant provenance mismatch for memory: ${hit.memoryId}`,
        );
      }
      return { record, score: hit.score, rank: 0 };
    }).sort((left, right) =>
      right.score - left.score ||
      left.record.memoryId.localeCompare(right.record.memoryId)
    ).slice(0, limit).map((hit, index) => ({ ...hit, rank: index + 1 }));
  }

  async search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]> {
    request.signal?.throwIfAborted();
    if (request.filters?.roles?.length === 0 || request.filters?.sessionIds?.length === 0) {
      return request.queryVectors.map(() => []);
    }
    const generation = await this.options.store.assertVectorIndexGenerationReady(
      this.vectorGenerationId,
    );
    if (
      generation.collectionName !== this.vectorCollection ||
      generation.profile.profileId !== request.profile.profileId ||
      generation.profile.model !== request.profile.model ||
      generation.profile.dimensions !== request.profile.dimensions
    ) {
      throw new DenseRetrievalError(
        "configuration",
        `Qdrant generation mismatch: ${this.vectorGenerationId}`,
      );
    }
    const [embeddingStatus, generationScopeCount] = await Promise.all([
      this.options.store.getEmbeddingIndexStatus(request.scopeId, request.profile),
      this.options.store.getVectorGenerationScopeCount(
        this.vectorGenerationId,
        request.scopeId,
      ),
    ]);
    if (
      embeddingStatus.total === 0 ||
      embeddingStatus.missing !== 0 ||
      generationScopeCount !== embeddingStatus.total
    ) {
      throw new DenseRetrievalError(
        "integrity",
        `Qdrant generation does not cover scope ${request.scopeId}: ` +
          `${generationScopeCount}/${embeddingStatus.total}`,
      );
    }
    for (const vector of request.queryVectors) {
      if (
        vector.length !== request.profile.dimensions ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new DenseRetrievalError(
          "configuration",
          "Qdrant query vector does not match the embedding profile",
        );
      }
    }
    const filters = request.filters;
    return Promise.all(request.queryVectors.map(async (vector) => {
      let hits: QdrantSearchHit[];
      try {
        hits = await this.options.client.search({
          collection: this.vectorCollection,
          vector,
          generationId: this.vectorGenerationId,
          scopeId: request.scopeId,
          profileId: request.profile.profileId,
          ...(filters?.sessionIds === undefined ? {} : { sessionIds: filters.sessionIds }),
          ...(filters?.roles === undefined ? {} : { roles: filters.roles }),
          ...(filters?.after === undefined ? {} : { after: filters.after }),
          ...(filters?.before === undefined ? {} : { before: filters.before }),
          limit: request.limit,
          hnswEf: Math.min(10_000, Math.max(this.hnswEf, request.limit * 2)),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        throw qdrantSearchFailure(error, request.signal?.aborted === true);
      }
      return this.hydrate(request.scopeId, hits, request.limit);
    }));
  }
}
