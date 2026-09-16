import type { MemoryRecord } from "../../memory/index.js";
import type { EmbeddingProfile } from "../model/embedding.js";
import type {
  RetrievalProfile,
  SearchRequest,
  VectorSearchConfiguration,
} from "../model/search.js";

export type DenseRetrievalFailureKind =
  | "unavailable"
  | "configuration"
  | "integrity";

/** Typed failure boundary used by resilience policies around dense retrieval. */
export class DenseRetrievalError extends Error {
  constructor(
    readonly kind: DenseRetrievalFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DenseRetrievalError";
  }
}

export interface DenseSearchHit {
  record: MemoryRecord;
  score: number;
  rank: number;
}

export interface DenseSearchBatchRequest {
  scopeId: string;
  profile: EmbeddingProfile;
  queryVectors: readonly (readonly number[])[];
  limit: number;
  filters?: Omit<SearchRequest, "queries" | "limit">;
  signal?: AbortSignal;
}

/** Internal dense boundary. It is deliberately absent from Agent tool schemas. */
export interface DenseRetriever {
  readonly retrievalProfile: RetrievalProfile;
  readonly vectorGenerationId?: string;
  readonly vectorCollection?: string;
  readonly vectorSearch?: VectorSearchConfiguration;
  snapshotFallbackCount?(): number;
  search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]>;
}
