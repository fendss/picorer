import type { MemoryRecord } from "../../memory/index.js";
import type {
  EvidenceOperatorSearchContext,
  RetrievalHit,
  SearchRequest,
} from "../model/search.js";

export interface SearchOperatorStore {
  search(
    scopeId: string,
    request: SearchRequest,
    signal?: AbortSignal,
  ): RetrievalHit[] | Promise<RetrievalHit[]>;
  searchLexical?(
    scopeId: string,
    request: SearchRequest,
    signal?: AbortSignal,
  ): RetrievalHit[] | Promise<RetrievalHit[]>;
  expandEvidenceOperator?(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly RetrievalHit[],
  ): RetrievalHit[] | Promise<RetrievalHit[]>;
}

export interface MemoryToolStore extends SearchOperatorStore {
  read(
    scopeId: string,
    memoryIds: string[],
    contextBefore?: number,
    contextAfter?: number,
  ): MemoryRecord[];
}
