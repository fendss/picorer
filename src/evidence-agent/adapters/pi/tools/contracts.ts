import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ReadOnlyNavigation } from "../../../ports/read-only-navigation.js";
import type { MemoryRecord } from "../../../../memory/index.js";
import type {
  DefinedSearchOperator,
  EvidenceOperatorResult,
  MemoryToolStore,
  RuntimeSearchOperatorCatalog,
  SearchCoverageProgress,
  SearchOperatorCatalog,
  SearchOperatorCompositionTrace,
  SearchOperatorDefinitionSnapshot,
  SearchRequest,
  MemoryPassage,
} from "../../../../retrieval/index.js";
import type {
  MemoryCandidate,
  PicorerSelection,
} from "../../../model/evidence.js";
import type { MemoryEvidence } from "../../../model/source-evidence.js";
import type { MemoryLedger } from "../../../model/ledger.js";
import type { MemoryObservation } from "../memory-observation.js";
import {
  BashRoParameters,
  DefineOperatorParameters,
  FinishParameters,
  ReadParameters,
  SearchMoreParameters,
  type SearchParametersSchema,
} from "./schemas.js";

export type CandidateToolDetails = Omit<MemoryCandidate, "passage"> & {
  passage?: Omit<MemoryPassage, "content">;
};

export interface SearchToolDetails {
  kind: "search";
  request: SearchRequest;
  executedQueries: string[];
  operator: string;
  operatorVersion: string;
  operatorResult?: EvidenceOperatorResult;
  composition?: SearchOperatorCompositionTrace;
  candidateReferences: Array<{
    candidateRef: string;
    candidateId?: string;
    memoryId: string;
  }>;
  candidates: CandidateToolDetails[];
  /**
   * Reservoir candidates exposed as a compact, directly readable directory.
   * They are retrieved by the same physical search as `candidates`; they are
   * not a second search or a second ranking.
   */
  directoryCandidateReferences?: Array<{
    candidateRef: string;
    candidateId?: string;
    memoryId: string;
  }>;
  directoryCandidates?: CandidateToolDetails[];
  coverageProgress: SearchCoverageProgress;
  repeatedQueries?: string[];
  /** Auditable boundary for the one physical retrieval; full passage text is omitted. */
  physicalPlan?: {
    candidateReservoirLimit: number;
    candidateReservoirCount: number;
    exhausted: boolean;
  };
  pagination?: {
    mode: "initial" | "continuation";
    page: number;
    depth: number;
    hasMore: boolean;
    /** Candidates still available as compact C-ref directory entries. */
    directoryCandidateCount?: number;
    /** False for search; true when search_more only changes presentation. */
    presentationOnly?: boolean;
  };
}

export interface DefineOperatorToolDetails {
  kind: "define_operator";
  definition: DefinedSearchOperator;
  snapshot: SearchOperatorDefinitionSnapshot;
}

export interface ReadToolDetails {
  kind: "read";
  requestedCandidateRefs: string[];
  requestedMemoryIds: string[];
  contextBefore: number;
  contextAfter: number;
  evidence: Array<Pick<
    MemoryEvidence,
    | "memoryId"
    | "scopeId"
    | "sessionId"
    | "turnIndex"
    | "contentHash"
    | "sourceContentHash"
    | "sourceContentLength"
    | "truncated"
  > & { excerpts: Array<{ start: number; end: number }> }>;
  evidenceReferences: Array<{
    evidenceRef: string;
    candidateRef: string;
    memoryId: string;
  }>;
  expandedMemoryIds: string[];
  candidates: CandidateToolDetails[];
}

export interface FinishToolDetails {
  kind: "finish";
  /** Harness-generated E refs for every exact source returned by read. */
  committedEvidenceRefs: string[];
  committedEvidence: Array<Pick<
    MemoryEvidence,
    | "memoryId"
    | "scopeId"
    | "sessionId"
    | "turnIndex"
    | "role"
    | "timestamp"
    | "contentHash"
    | "sourceContentHash"
    | "sourceContentLength"
    | "truncated"
  >>;
  selection: PicorerSelection;
}

export interface BashRoToolDetails {
  kind: "bash_ro";
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  memoryIds: string[];
  candidateReferences: Array<{ candidateRef: string; memoryId: string }>;
  candidates: MemoryCandidate[];
}

export interface MemoryLookup {
  findMentionedMemoryIds(scopeId: string, text: string): string[];
  getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[];
}

export interface CreatePicorerToolsOptions {
  store: MemoryToolStore;
  operatorRegistry: SearchOperatorCatalog;
  operatorDefinitions?: RuntimeSearchOperatorCatalog;
  scopeId: string;
  ledger: MemoryLedger;
  bashRo?: {
    runner: ReadOnlyNavigation;
    scopePath: string;
    store: MemoryLookup;
  };
  beforeFinish?: (selection: PicorerSelection) => Promise<void> | void;
  question?: string;
  /** Current runtime inputs used only to focus bounded exact evidence excerpts. */
  evidenceFocus?: () => readonly string[];
  questionDate?: string;
  searchDefaults?: Pick<SearchRequest, "limit" | "order" | "maxPerSession">;
  maxSearchCalls?: number;
  /** Keep advanced retrieval implementation private behind a small model-facing contract. */
  interfaceMode?: "full" | "compact";
  /** Shared model-facing snapshot. Created automatically by createPicorerTools. */
  observation?: MemoryObservation;
}

export interface PicorerTools {
  search: AgentTool<SearchParametersSchema, SearchToolDetails>;
  searchMore: AgentTool<typeof SearchMoreParameters, SearchToolDetails>;
  defineOperator?: AgentTool<
    typeof DefineOperatorParameters,
    DefineOperatorToolDetails
  >;
  read: AgentTool<typeof ReadParameters, ReadToolDetails>;
  bashRo?: AgentTool<typeof BashRoParameters, BashRoToolDetails>;
  finish: AgentTool<typeof FinishParameters, FinishToolDetails>;
  all: AgentTool[];
}
