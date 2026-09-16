import type { MemoryRecord } from "../../memory/index.js";
import type { EmbeddingIndexStore } from "../model/embedding.js";
import type {
  EvidenceOperatorSearchContext,
  RetrievalHit,
  SearchRequest,
} from "../model/search.js";

/** Persistence capabilities required by hybrid retrieval policy. */
export interface HybridSearchStore extends EmbeddingIndexStore {
  search(scopeId: string, request: SearchRequest): RetrievalHit[];
  expandEvidenceOperator(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly RetrievalHit[],
  ): RetrievalHit[];
  read(
    scopeId: string,
    memoryIds: string[],
    contextBefore?: number,
    contextAfter?: number,
  ): MemoryRecord[];
  getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[];
  findMentionedMemoryIds(scopeId: string, text: string): string[];
}
