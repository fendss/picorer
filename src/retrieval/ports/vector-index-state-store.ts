import type {
  EmbeddingProfile,
  VectorIndexGenerationConfig,
  VectorIndexGenerationStatus,
  VectorSyncClaim,
} from "../model/embedding.js";

/** Durable state required to publish one immutable vector-index generation. */
export interface VectorIndexStateStore {
  beginVectorIndexGeneration(
    config: VectorIndexGenerationConfig,
  ): VectorIndexGenerationStatus;
  enqueueStoredScopeEmbeddingsForVectorGeneration(
    generationId: string,
    scopeId: string,
    profile: EmbeddingProfile,
  ): number;
  getVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus;
  sealVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus;
  claimVectorSyncBatch(
    generationId: string,
    limit: number,
    leaseMs: number,
    nowMs?: number,
  ): VectorSyncClaim[];
  completeVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
  ): void;
  releaseVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
    error: unknown,
  ): void;
  beginVectorIndexVerification(
    generationId: string,
  ): VectorIndexGenerationStatus;
  markVectorIndexGenerationReady(
    generationId: string,
    observedVectorCount: number,
  ): VectorIndexGenerationStatus;
  failVectorIndexGeneration(generationId: string, error: unknown): void;
  assertVectorIndexGenerationReady(
    generationId: string,
  ): VectorIndexGenerationStatus;
  listVectorGenerationScopeCounts(
    generationId: string,
  ): Array<{ scopeId: string; count: number }>;
  getVectorGenerationScopeCount(
    generationId: string,
    scopeId: string,
  ): number;
}
