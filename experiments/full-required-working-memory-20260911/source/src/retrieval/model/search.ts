import type { MemoryRecord, MemoryRole } from "../../memory/index.js";
import type { MemoryPassage } from "./passage.js";

export type SearchOrder =
  | "relevance"
  | "chronological"
  | "reverse-chronological";

export interface EvidenceOperatorSearchContext {
  operator: "temporal" | "numeric";
  maxCandidates: number;
  targetDates?: string[];
}

export type NumericValueKind =
  | "increment"
  | "cumulative"
  | "snapshot"
  | "target"
  | "unknown";

export interface EvidenceOperatorRow {
  slot: string;
  quote: string;
  memoryId: string;
  sessionId: string;
  turnIndex: number;
  role: MemoryRole;
  eventTime?: string;
  mentionedDates?: string[];
  value?: number;
  unit?: string;
  valueKind?: NumericValueKind;
  dedupeKey?: string;
  rawValue?: string;
  sourceSpan?: { start: number; end: number };
}

export interface EvidenceOperatorResult {
  version: "picorer-evidence-operators-v1";
  operator: "temporal" | "numeric";
  rows: EvidenceOperatorRow[];
  coverage: {
    candidateCount: number;
    distinctSessions: number;
    truncated: boolean;
  };
  temporalPlan?: {
    questionDate?: string;
    targets: Array<{
      expression: string;
      date: string;
      basis: "relative-to-question" | "explicit-in-question";
    }>;
    auxiliaryWindowApplied: boolean;
  };
  derived?: Record<string, unknown>;
}

export interface SearchRequest {
  queries: string[];
  limit?: number;
  sessionIds?: string[];
  roles?: MemoryRole[];
  after?: string;
  before?: string;
  order?: SearchOrder;
  maxPerSession?: number;
}

/** Metadata constraint copied verbatim from one Agent-authored query path. */
export interface RetrievalMetadataFilter {
  source: "agent-query";
  query: string;
  expression: string;
  after: string;
  before: string;
}

export interface RetrievalHit {
  record: MemoryRecord;
  /** Exact passage selected from the immutable parent record for Agent review. */
  passage?: MemoryPassage;
  query: string;
  /**
   * Query paths that admitted this hit into a multi-query result. Primitive
   * stores may omit this when they only expose the winning query; consumers
   * must then treat `query` as the single known path rather than infer more.
   */
  matchedQueries?: string[];
  /** Physical metadata routes that also admitted this hit. */
  matchedMetadataFilters?: RetrievalMetadataFilter[];
  retriever:
    | "fts5"
    | "picorer-hybrid"
    | "picorer-timeline-db"
    | "picorer-aggregate-db";
  rank: number;
  score: number;
  preview: string;
  /** Exact immutable-source spans surfaced by structured index primitives. */
  operatorSourceSpans?: Array<{ start: number; end: number }>;
  operatorNumericFactIndexes?: number[];
  operatorTemporalFacts?: Array<{
    expression: string;
    resolvedDate: string;
    basis: string;
  }>;
}

export type SearchFrontierStatus =
  | "new-sessions"
  | "known-session-depth"
  | "no-new-candidates";

export interface SearchQueryCoverageProgress {
  query: string;
  repeated: boolean;
  returnedCandidateCount: number;
  returnedSessionCount: number;
  newCandidateCount: number;
  newSessionCount: number;
}

/**
 * Honest, run-local search progress. This describes only what the current
 * bounded query window returned relative to earlier navigation results. It is
 * deliberately not a recall estimate and never claims corpus completeness.
 */
export interface SearchCoverageProgress {
  call: number;
  status: SearchFrontierStatus;
  requestedLimit: number;
  reachedRequestedLimit: boolean;
  returnedCandidateCount: number;
  returnedSessionCount: number;
  newCandidateCount: number;
  repeatedCandidateCount: number;
  newSessionCount: number;
  repeatedSessionCount: number;
  newQueryCount: number;
  repeatedQueryCount: number;
  consecutiveNoNewCandidateCalls: number;
  consecutiveNoNewSessionCalls: number;
  queries: SearchQueryCoverageProgress[];
}

export type RetrievalProfile =
  | "fts5"
  | "picorer-hybrid"
  | "picorer-hybrid-qdrant-hnsw-v1";

/** Result-affecting configuration for an external approximate vector index. */
export interface VectorSearchConfiguration {
  algorithm: "qdrant-hnsw";
  hnswM: number;
  efConstruct: number;
  hnswEf: number;
  fullScanThresholdKb: number;
  indexingThresholdKb: number;
  exact: false;
  requestTimeoutMs: number;
  fallbackPolicy?: "sqlite-exact-on-unavailable-v1";
}

export interface RetrievalMetadata {
  retrievalProfile: RetrievalProfile;
  embeddingProfileId?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  vectorGenerationId?: string;
  vectorCollection?: string;
  vectorSearch?: VectorSearchConfiguration;
}

export interface RetrievalMetricsSnapshot {
  embeddingCalls: number;
  embeddingLatencyMs: number;
  denseCandidateCount: number;
  rerankCandidateCount: number;
  denseFallbackCount: number;
}

/** Shared identity for repeated queries and per-query coverage accounting. */
export function searchQueryFingerprint(query: string): string {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
