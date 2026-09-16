import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Embedder,
  EmbeddingMetrics,
  EmbeddingRequestOptions,
} from "../../../retrieval/index.js";
import {
  MemoryArenaOperationDiagnosticError,
  MemoryArenaPublicError,
  type MemoryArenaEmbeddingMetrics,
  type MemoryArenaOperationEmbeddingAudit,
} from "../model/memory-backend.js";
import type { MemoryArenaEmbeddingOperationMeter } from "../ports/memory-backend.js";

/**
 * Embedder boundary needed by MemoryArena for exact provider-attempt accounting.
 * The production OpenAI-compatible embedder implements this structurally.
 */
export interface MemoryArenaAttemptMeteredEmbedder extends Embedder {
  captureEmbeddingAttempts<T>(
    observer: (metrics: EmbeddingMetrics) => void,
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface OperationAccumulator extends MemoryArenaEmbeddingMetrics {
  open: boolean;
}

function zeroAccumulator(): OperationAccumulator {
  return {
    calls: 0,
    latencyMs: 0,
    inputTokens: 0,
    usageMissingCalls: 0,
    open: true,
  };
}

function embeddingAudit(
  accumulator: OperationAccumulator,
): MemoryArenaOperationEmbeddingAudit {
  return {
    measurement: "async_context",
    delta: {
      calls: accumulator.calls,
      latencyMs: accumulator.latencyMs,
      inputTokens: accumulator.inputTokens,
      usageMissingCalls: accumulator.usageMissingCalls,
    },
  };
}

function attachEmbeddingDiagnostics(
  error: unknown,
  embedding: MemoryArenaOperationEmbeddingAudit,
): Error {
  const diagnostics = { embedding };
  if (error instanceof MemoryArenaPublicError) {
    return new MemoryArenaPublicError({
      code: error.code,
      message: error.message,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      cause: error,
      diagnostics,
    });
  }
  return new MemoryArenaOperationDiagnosticError({
    message: error instanceof Error ? error.message : "MemoryArena operation failed",
    cause: error,
    diagnostics,
  });
}

/**
 * Routes exact provider-attempt metrics through async context to the add/wrap
 * operation that initiated each call. It adds no concurrency gate: provider
 * attempts, retrieval agents, retry backoff, and model calls remain parallel.
 */
export class MemoryArenaMeasuredEmbedder
  implements Embedder, MemoryArenaEmbeddingOperationMeter {
  readonly profileId: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputLength: number;
  readonly batchSize: number;

  private readonly operations = new AsyncLocalStorage<OperationAccumulator>();

  constructor(private readonly delegate: MemoryArenaAttemptMeteredEmbedder) {
    this.profileId = delegate.profileId;
    this.model = delegate.model;
    this.dimensions = delegate.dimensions;
    this.maxInputLength = delegate.maxInputLength;
    this.batchSize = delegate.batchSize;
  }

  async measureOperation<T>(operation: () => Promise<T>): Promise<{
    result: T;
    embedding: MemoryArenaOperationEmbeddingAudit;
  }> {
    if (this.operations.getStore() !== undefined) {
      throw new Error("MemoryArena embedding operations must not be nested");
    }
    const accumulator = zeroAccumulator();
    try {
      const result = await this.operations.run(accumulator, operation);
      accumulator.open = false;
      return { result, embedding: embeddingAudit(accumulator) };
    } catch (error) {
      accumulator.open = false;
      throw attachEmbeddingDiagnostics(error, embeddingAudit(accumulator));
    }
  }

  embedDocuments(
    texts: readonly string[],
    options: EmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    return this.measuredCall(() => this.delegate.embedDocuments(texts, options));
  }

  embedQueries(
    texts: readonly string[],
    options: EmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    return this.measuredCall(() => this.delegate.embedQueries(texts, options));
  }

  snapshotMetrics(): EmbeddingMetrics {
    return this.delegate.snapshotMetrics();
  }

  private measuredCall<T>(operation: () => Promise<T>): Promise<T> {
    const accumulator = this.operations.getStore();
    if (accumulator === undefined || !accumulator.open) {
      return Promise.reject(
        new Error("MemoryArena embedding call has no active operation context"),
      );
    }
    return this.delegate.captureEmbeddingAttempts(
      (metrics) => {
        if (!accumulator.open) {
          return;
        }
        accumulator.calls += metrics.calls;
        accumulator.latencyMs += metrics.latencyMs;
        accumulator.inputTokens += metrics.inputTokens ?? 0;
        accumulator.usageMissingCalls += metrics.usageMissingCalls ?? 0;
      },
      operation,
    );
  }
}
