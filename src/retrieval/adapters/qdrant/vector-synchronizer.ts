import { createHash } from "node:crypto";
import type {
  VectorIndexGenerationStatus,
  VectorSyncClaim,
} from "../../model/embedding.js";
import type { VectorIndexStateStore } from "../../ports/vector-index-state-store.js";
import {
  QdrantHttpError,
  type QdrantCollectionInfo,
  type QdrantCollectionSpec,
  type QdrantCountRequest,
  type QdrantVectorPoint,
} from "./client.js";

export interface QdrantVectorIndexClient {
  ensureCollection(spec: QdrantCollectionSpec, signal?: AbortSignal): Promise<void>;
  getCollection(
    name: string,
    signal?: AbortSignal,
  ): Promise<QdrantCollectionInfo | undefined>;
  upsert(
    collection: string,
    dimensions: number,
    points: readonly QdrantVectorPoint[],
    signal?: AbortSignal,
  ): Promise<void>;
  count(request: QdrantCountRequest): Promise<number>;
}

export interface QdrantVectorSynchronizerOptions {
  store: VectorIndexStateStore;
  client: QdrantVectorIndexClient;
  generationId: string;
  collection: QdrantCollectionSpec;
  batchSize?: number;
  concurrentBatches?: number;
  leaseMs?: number;
  verificationPollMs?: number;
  verificationTimeoutMs?: number;
}

function boundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return value;
}

export function deterministicQdrantPointId(
  generationId: string,
  scopeId: string,
  memoryId: string,
  profileId: string,
): string {
  if (!generationId || !scopeId || !memoryId || !profileId) {
    throw new Error("Qdrant point identity fields must not be empty");
  }
  const bytes = Buffer.from(createHash("sha256")
    .update("picorer-qdrant-point-v2\0")
    .update(generationId)
    .update("\0")
    .update(scopeId)
    .update("\0")
    .update(memoryId)
    .update("\0")
    .update(profileId)
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function pointFromClaim(claim: VectorSyncClaim): QdrantVectorPoint {
  return {
    pointId: deterministicQdrantPointId(
      claim.generationId,
      claim.scopeId,
      claim.memoryId,
      claim.profileId,
    ),
    vector: [...claim.vector],
    generationId: claim.generationId,
    scopeId: claim.scopeId,
    memoryId: claim.memoryId,
    sessionId: claim.sessionId,
    role: claim.role,
    ...(claim.timestamp === undefined ? {} : { timestamp: claim.timestamp }),
    profileId: claim.profileId,
    contentHash: claim.contentHash,
  };
}

function permanentFailure(error: unknown): boolean {
  return error instanceof QdrantHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429;
}

export function qdrantCollectionIndexReady(
  info: Pick<
    QdrantCollectionInfo,
    | "status"
    | "optimizerStatus"
    | "pointsCount"
    | "indexedVectorsCount"
    | "segmentsCount"
  >,
  dimensions: number,
  indexingThresholdKb: number,
): boolean {
  const unindexed = Math.max(0, info.pointsCount - info.indexedVectorsCount);
  const tailKb = unindexed * dimensions * Float32Array.BYTES_PER_ELEMENT / 1_024;
  const settledSegments = Math.max(1, info.segmentsCount);
  return info.status.toLowerCase() === "green" &&
    info.optimizerStatus.toLowerCase() === "ok" &&
    tailKb < indexingThresholdKb * settledSegments;
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Vector synchronization aborted");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Vector synchronization aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Publishes an immutable, resumable Qdrant generation from SQLite outbox rows. */
export class QdrantVectorSynchronizer {
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: QdrantVectorSynchronizerOptions) {
    this.batchSize = boundedInteger(options.batchSize ?? 512, "Sync batch size", 10_000);
    this.concurrency = boundedInteger(options.concurrentBatches ?? 4, "Sync concurrency", 64);
    this.leaseMs = boundedInteger(options.leaseMs ?? 120_000, "Sync lease", 86_400_000);
    this.pollMs = boundedInteger(options.verificationPollMs ?? 1_000, "Verification poll", 60_000);
    this.timeoutMs = boundedInteger(
      options.verificationTimeoutMs ?? 3_600_000,
      "Verification timeout",
      86_400_000,
    );
  }

  async initialize(signal?: AbortSignal): Promise<VectorIndexGenerationStatus> {
    const status = this.options.store.getVectorIndexGeneration(this.options.generationId);
    if (
      status.collectionName !== this.options.collection.name ||
      status.profile.dimensions !== this.options.collection.dimensions
    ) {
      throw new Error(`Vector synchronizer configuration mismatch: ${status.generationId}`);
    }
    try {
      await this.options.client.ensureCollection(this.options.collection, signal);
    } catch (error) {
      if (permanentFailure(error) && status.state !== "ready") {
        this.options.store.failVectorIndexGeneration(status.generationId, error);
      }
      throw error;
    }
    return status;
  }

  private async worker(signal: AbortSignal | undefined, shouldStop: () => boolean, onFailure: (error: unknown) => void): Promise<number> {
    let synchronized = 0;
    while (!shouldStop()) {
      if (signal?.aborted) throw new Error("Vector synchronization aborted");
      const claims = this.options.store.claimVectorSyncBatch(
        this.options.generationId,
        this.batchSize,
        this.leaseMs,
      );
      if (claims.length === 0) return synchronized;
      const ids = claims.map((claim) => claim.sequenceId);
      try {
        await this.options.client.upsert(
          this.options.collection.name,
          this.options.collection.dimensions,
          claims.map(pointFromClaim),
          signal,
        );
        this.options.store.completeVectorSyncBatch(this.options.generationId, ids);
        synchronized += claims.length;
      } catch (error) {
        onFailure(error);
        this.options.store.releaseVectorSyncBatch(this.options.generationId, ids, error);
        if (permanentFailure(error)) {
          this.options.store.failVectorIndexGeneration(this.options.generationId, error);
        }
        throw error;
      }
    }
    return synchronized;
  }

  async synchronizeAvailable(signal?: AbortSignal): Promise<number> {
    const status = await this.initialize(signal);
    if (status.state !== "ingesting" && status.state !== "draining") return 0;
    let failed = false;
    let firstError: unknown;
    const onFailure = (error: unknown): void => {
      if (!failed) firstError = error;
      failed = true;
    };
    const counts = await Promise.all(Array.from({ length: this.concurrency }, async () => {
      try { return await this.worker(signal, () => failed, onFailure); }
      catch (error) {
        onFailure(error);
        return 0;
      }
    }));
    if (failed) throw firstError;
    return counts.reduce((sum, value) => sum + value, 0);
  }

  private async waitForIndex(
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const info = await this.options.client.getCollection(
        this.options.collection.name,
        signal,
      );
      if (info === undefined) {
        throw new Error(`Qdrant collection disappeared: ${this.options.collection.name}`);
      }
      if (qdrantCollectionIndexReady(
        info,
        this.options.collection.dimensions,
        this.options.collection.indexingThresholdKb,
      )) return;
      if (Date.now() >= deadline) {
        throw new Error(`Qdrant indexing did not finish: ${this.options.collection.name}`);
      }
      await wait(this.pollMs, signal);
    }
  }

  private async verifyCounts(
    status: VectorIndexGenerationStatus,
    signal?: AbortSignal,
  ): Promise<number> {
    const observed = await this.options.client.count({
      collection: status.collectionName,
      generationId: status.generationId,
      profileId: status.profile.profileId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (observed !== status.expectedVectorCount) {
      throw new Error(`Qdrant generation count mismatch: ${observed}/${status.expectedVectorCount}`);
    }
    for (const scope of this.options.store.listVectorGenerationScopeCounts(status.generationId)) {
      const count = await this.options.client.count({
        collection: status.collectionName,
        generationId: status.generationId,
        profileId: status.profile.profileId,
        scopeId: scope.scopeId,
        ...(signal === undefined ? {} : { signal }),
      });
      if (count !== scope.count) {
        throw new Error(`Qdrant scope count mismatch for ${scope.scopeId}: ${count}/${scope.count}`);
      }
    }
    return observed;
  }

  async finalize(signal?: AbortSignal): Promise<VectorIndexGenerationStatus> {
    let status = await this.initialize(signal);
    if (status.state === "ready") {
      await this.waitForIndex(signal);
      await this.verifyCounts(status, signal);
      return status;
    }
    if (status.state === "failed") {
      throw new Error(`Cannot finalize failed vector generation: ${status.generationId}`);
    }
    if (status.state === "ingesting" || status.state === "draining") {
      status = this.options.store.sealVectorIndexGeneration(status.generationId);
    }
    if (status.state === "draining") {
      await this.synchronizeAvailable(signal);
      status = this.options.store.beginVectorIndexVerification(status.generationId);
    }
    if (status.state !== "verifying") {
      throw new Error(`Vector generation cannot be verified: ${status.generationId}`);
    }
    await this.waitForIndex(signal);
    try {
      const observed = await this.verifyCounts(status, signal);
      return this.options.store.markVectorIndexGenerationReady(
        status.generationId,
        observed,
      );
    } catch (error) {
      if (
        permanentFailure(error) ||
        (error instanceof Error && /count mismatch/u.test(error.message))
      ) {
        this.options.store.failVectorIndexGeneration(status.generationId, error);
      }
      throw error;
    }
  }
}
