import type {
  EvidenceOperatorResult,
  RetrievalHit,
  SearchOrder,
  SearchRequest,
} from "./search.js";
import type { MemoryRole } from "../../memory/index.js";

export type SearchOperatorCost = "low" | "medium" | "high";

export interface SearchOperatorGuide {
  summary: string;
  useWhen: readonly string[];
  avoidWhen?: readonly string[];
  cost: SearchOperatorCost;
}

export interface SearchOperatorCatalogEntry {
  id: string;
  version: string;
  guide: SearchOperatorGuide;
}

export interface SearchOperatorInput {
  queries: string[];
  limit: number;
  roles?: MemoryRole[];
  maxPerSession?: number;
}

export interface SearchOperatorExecutionContext {
  scopeId: string;
  question?: string;
  questionDate?: string;
  signal?: AbortSignal;
}

export interface SearchOperatorOutput {
  request: SearchRequest;
  hits: RetrievalHit[];
  operatorResult?: EvidenceOperatorResult;
  composition?: SearchOperatorCompositionTrace;
}

/** Internal immutable-history search value. It is not Evidence. */
export interface CandidateSet {
  readonly hits: readonly RetrievalHit[];
}

export type SearchOperatorCombineMethod = "union" | "rrf" | "intersection";

export interface SearchOperatorDefinitionSearchStep {
  id: string;
  kind: "search";
  operator: string;
  queries?: string[];
  limit?: number;
}

export interface SearchOperatorDefinitionCombineStep {
  id: string;
  kind: "combine";
  inputs: string[];
  method: SearchOperatorCombineMethod;
  limit?: number;
}

export interface SearchOperatorDefinitionFilterStep {
  id: string;
  kind: "filter";
  input: string;
  roles: MemoryRole[];
}

export interface SearchOperatorDefinitionSortStep {
  id: string;
  kind: "sort";
  input: string;
  order: SearchOrder;
}

export interface SearchOperatorDefinitionDiversifyStep {
  id: string;
  kind: "diversify";
  input: string;
  by: "session";
  maxPerGroup: number;
}

export interface SearchOperatorDefinitionDedupeStep {
  id: string;
  kind: "dedupe";
  input: string;
  by: "content";
}

export interface SearchOperatorDefinitionLimitStep {
  id: string;
  kind: "limit";
  input: string;
  limit: number;
}

export interface SearchOperatorDefinitionAnnotateStep {
  id: string;
  kind: "annotate";
  input: string;
  method: "temporal" | "numeric";
}

export type SearchOperatorDefinitionStep =
  | SearchOperatorDefinitionSearchStep
  | SearchOperatorDefinitionCombineStep
  | SearchOperatorDefinitionFilterStep
  | SearchOperatorDefinitionSortStep
  | SearchOperatorDefinitionDiversifyStep
  | SearchOperatorDefinitionDedupeStep
  | SearchOperatorDefinitionLimitStep
  | SearchOperatorDefinitionAnnotateStep;

/**
 * A deliberately small, declarative operator definition.
 *
 * Search steps call already trusted operators. Combine steps transform only
 * CandidateSets, so runtime-created operators can never read source text or
 * promote evidence by themselves.
 */
export interface SearchOperatorDefinition {
  id: string;
  version: string;
  guide: SearchOperatorGuide;
  steps: SearchOperatorDefinitionStep[];
  output: string;
}

export interface SearchOperatorCompositionStepTrace {
  id: string;
  kind: SearchOperatorDefinitionStep["kind"];
  operator?: string;
  operatorVersion?: string;
  queries?: string[];
  inputs?: string[];
  input?: string;
  method?: SearchOperatorCombineMethod;
  roles?: MemoryRole[];
  order?: SearchOrder;
  by?: "session" | "content";
  maxPerSession?: number;
  maxPerGroup?: number;
  limit?: number;
  annotation?: "temporal" | "numeric";
  candidateCount: number;
}

export interface SearchOperatorCompositionTrace {
  definitionHash: string;
  definitionRevision: number;
  steps: SearchOperatorCompositionStepTrace[];
}

export interface SearchOperatorCatalogIdentity {
  revision: number;
  hash: string;
}

export interface DefinedSearchOperator {
  id: string;
  version: string;
  definitionHash: string;
  catalog: SearchOperatorCatalogIdentity;
}

export interface SearchOperatorDefinitionSnapshot {
  revision: number;
  definitionHash: string;
  definition: SearchOperatorDefinition;
}
