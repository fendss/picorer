import type { MemoryRecord } from "../../memory/index.js";
import type { SearchRequest } from "./search.js";

export interface EmbeddingProfile {
  profileId: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingIndexStatus {
  scopeId: string;
  profileId: string;
  total: number;
  indexed: number;
  missing: number;
}

export interface StoredEmbeddingRecord {
  record: MemoryRecord;
  vector: Float32Array;
}

export interface StoreEmbeddingBatchResult {
  inserted: number;
  unchanged: number;
}

export type VectorIndexGenerationState =
  | "ingesting"
  | "draining"
  | "verifying"
  | "ready"
  | "failed";

export interface VectorIndexGenerationConfig {
  generationId: string;
  collectionName: string;
  profile: EmbeddingProfile;
}

export interface VectorIndexGenerationStatus
  extends VectorIndexGenerationConfig {
  state: VectorIndexGenerationState;
  sourceFingerprint?: string;
  expectedVectorCount: number;
  syncedVectorCount: number;
  pendingVectorCount: number;
  inflightVectorCount: number;
  highWaterSequence: number;
  lastError?: string;
}

export interface VectorSyncClaim {
  sequenceId: number;
  generationId: string;
  scopeId: string;
  memoryId: string;
  sessionId: string;
  role: MemoryRecord["role"];
  timestamp?: string;
  profileId: string;
  contentHash: string;
  vector: Float32Array;
  attempts: number;
}

export interface EmbeddingIndexStore {
  getEmbeddingIndexStatus(
    scopeId: string,
    profile: EmbeddingProfile,
  ): EmbeddingIndexStatus;
  listMissingEmbeddingRecords(
    scopeId: string,
    profile: EmbeddingProfile,
  ): MemoryRecord[];
  storeEmbeddingBatch(
    records: readonly MemoryRecord[],
    profile: EmbeddingProfile,
    vectors: readonly (readonly number[])[],
  ): StoreEmbeddingBatchResult;
  listStoredEmbeddings(
    scopeId: string,
    profile: EmbeddingProfile,
    request?: Omit<SearchRequest, "queries" | "limit">,
  ): StoredEmbeddingRecord[];
}
