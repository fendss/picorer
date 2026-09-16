import type {
  MemoryArenaAppendMessage,
  MemoryArenaGenerationState,
  MemoryArenaOperationEmbeddingAudit,
  MemoryArenaOperationAuditFailure,
  MemoryArenaOperationAuditStart,
  MemoryArenaOperationAuditSuccess,
  MemoryArenaOriginalChunk,
  MemoryArenaOperatorExperimentInput,
  MemoryArenaRetrievalResult,
  MemoryArenaWrapAuditRecord,
} from "../model/memory-backend.js";

export interface MemoryArenaGenerationStore {
  initialize(
    userId: string,
    memorySystemName: string,
  ): Promise<MemoryArenaGenerationState>;
  get(userId: string): Promise<MemoryArenaGenerationState | undefined>;
  reserveAppend(options: {
    userId: string;
    generation: number;
    chunk: string;
  }): Promise<number>;
  completeAppend(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
  }): Promise<MemoryArenaGenerationState>;
}

export interface MemoryArenaChunkMemory {
  appendOriginalChunk(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
    messages?: readonly MemoryArenaAppendMessage[];
  }): Promise<void>;
  readOriginalChunks(options: {
    userId: string;
    generation: number;
    memoryIds: readonly string[];
  }): Promise<MemoryArenaOriginalChunk[]>;
}

export interface MemoryArenaEmbeddingOperationMeter {
  measureOperation<T>(operation: () => Promise<T>): Promise<{
    result: T;
    embedding: MemoryArenaOperationEmbeddingAudit;
  }>;
}

export interface MemoryArenaEvidenceRetriever {
  retrieve(options: {
    userId: string;
    generation: number;
    question: string;
    operatorExperiment?: MemoryArenaOperatorExperimentInput;
  }): Promise<MemoryArenaRetrievalResult>;
}

export interface MemoryArenaWrapAuditSink {
  record(record: MemoryArenaWrapAuditRecord): Promise<void>;
}

export interface MemoryArenaOperationAuditSpan {
  succeed(result: MemoryArenaOperationAuditSuccess): Promise<void>;
  fail(failure: MemoryArenaOperationAuditFailure): Promise<void>;
}

export interface MemoryArenaOperationAuditSink {
  begin(record: MemoryArenaOperationAuditStart): Promise<MemoryArenaOperationAuditSpan>;
}

export interface MemoryArenaPublicBackendDependencies {
  generations: MemoryArenaGenerationStore;
  chunks: MemoryArenaChunkMemory;
  retriever: MemoryArenaEvidenceRetriever;
  audits: MemoryArenaWrapAuditSink;
  operationAudits: MemoryArenaOperationAuditSink;
  embeddingMeter: MemoryArenaEmbeddingOperationMeter;
  memorySystemName: string;
}
