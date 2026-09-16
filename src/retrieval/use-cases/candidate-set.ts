import { retrievalHitIdentity } from "../model/passage.js";
import { mergeHitProvenance } from "../model/hit-provenance.js";
import { compareMemoryChronology } from "../model/source-time.js";
import type { EvidenceOperatorResult, RetrievalHit } from "../model/search.js";
import { buildAggregateOperatorResult } from "../operators/numeric-operator.js";
import { buildTimelineOperatorResult } from "../operators/temporal-operator.js";

const RRF_K = 60;

export function withRanks(hits: readonly RetrievalHit[], limit: number): RetrievalHit[] {
  return hits.slice(0, limit).map((hit, index) => ({
    ...hit,
    rank: index + 1,
  }));
}

export function unionCandidateSets(
  sets: readonly (readonly RetrievalHit[])[],
  limit: number,
): RetrievalHit[] {
  const hits: RetrievalHit[] = [];
  const indexes = new Map<string, number>();
  const maxDepth = Math.max(...sets.map((set) => set.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const set of sets) {
      const hit = set[depth];
      if (hit === undefined) continue;
      const existingIndex = indexes.get(retrievalHitIdentity(hit));
      if (existingIndex !== undefined) {
        const existing = hits[existingIndex]!;
        hits[existingIndex] = mergeHitProvenance(existing, hit);
        continue;
      }
      if (hits.length >= limit) continue;
      indexes.set(retrievalHitIdentity(hit), hits.length);
      hits.push(hit);
    }
  }
  return withRanks(hits, limit);
}

export function rrfCandidateSets(
  sets: readonly (readonly RetrievalHit[])[],
  limit: number,
): RetrievalHit[] {
  const fused = new Map<
    string,
    { hit: RetrievalHit; score: number; first: number }
  >();
  let first = 0;
  for (const set of sets) {
    set.forEach((hit, index) => {
      const key = retrievalHitIdentity(hit);
      const increment = 1 / (RRF_K + index + 1);
      const current = fused.get(key);
      if (current === undefined) {
        fused.set(key, { hit, score: increment, first });
        first += 1;
      } else {
        current.score += increment;
        current.hit = mergeHitProvenance(current.hit, hit);
      }
    });
  }
  return withRanks(
    [...fused.values()]
      .sort((left, right) =>
        right.score - left.score || left.first - right.first
      )
      .map(({ hit, score }) => ({ ...hit, score })),
    limit,
  );
}

export function intersectCandidateSets(
  sets: readonly (readonly RetrievalHit[])[],
  limit: number,
): RetrievalHit[] {
  const required = sets.length;
  const counts = new Map<string, { hit: RetrievalHit; count: number }>();
  for (const set of sets) {
    const seen = new Set<string>();
    for (const hit of set) {
      const key = retrievalHitIdentity(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current === undefined) counts.set(key, { hit, count: 1 });
      else {
        current.count += 1;
        current.hit = mergeHitProvenance(current.hit, hit);
      }
    }
  }
  return withRanks(
    [...counts.values()]
      .filter((entry) => entry.count === required)
      .map((entry) => entry.hit),
    limit,
  );
}

export function sortCandidateSet(
  hits: readonly RetrievalHit[],
  order: "relevance" | "chronological" | "reverse-chronological",
): RetrievalHit[] {
  if (order === "relevance") {
    return withRanks([...hits].sort((left, right) => right.score - left.score), hits.length);
  }
  const direction = order === "chronological" ? 1 : -1;
  return withRanks([...hits].sort((left, right) =>
    compareMemoryChronology(left.record, right.record, direction)
  ), hits.length);
}

export function diversifyBySession(
  hits: readonly RetrievalHit[],
  maxPerGroup: number,
): RetrievalHit[] {
  const groups = new Map<string, RetrievalHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.record.sessionId) ?? [];
    group.push(hit);
    groups.set(hit.record.sessionId, group);
  }
  const selected: RetrievalHit[] = [];
  for (let depth = 0; depth < maxPerGroup; depth += 1) {
    let progressed = false;
    for (const group of groups.values()) {
      const hit = group[depth];
      if (hit === undefined) continue;
      selected.push(hit);
      progressed = true;
    }
    if (!progressed) break;
  }
  return withRanks(selected, selected.length);
}

export function dedupeByContent(hits: readonly RetrievalHit[]): RetrievalHit[] {
  const seen = new Set<string>();
  return withRanks(hits.filter((hit) => {
    const fingerprint = hit.record.content
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }), hits.length);
}

export function annotateCandidateSet(
  method: "temporal" | "numeric",
  hits: readonly RetrievalHit[],
  question: string,
  questionDate: string | undefined,
): EvidenceOperatorResult {
  return method === "temporal"
    ? buildTimelineOperatorResult(hits, question, questionDate)
    : buildAggregateOperatorResult(hits);
}


/** Unary transformations retain only annotations whose sources survive. */
export function retainOperatorResult(
  result: EvidenceOperatorResult | undefined,
  hits: readonly RetrievalHit[],
): { operatorResult?: EvidenceOperatorResult } {
  if (result === undefined) return {};
  const ids = new Set(hits.map((hit) => hit.record.memoryId));
  const rows = result.rows.filter((row) => ids.has(row.memoryId));
  const narrowed = rows.length !== result.rows.length;
  const { derived, ...source } = result;
  return { operatorResult: { ...source, rows,
    ...(!narrowed && derived !== undefined ? { derived } : {}),
    coverage: { candidateCount: hits.length,
      distinctSessions: new Set(hits.map((hit) => hit.record.sessionId)).size,
      truncated: result.coverage.truncated || narrowed },
  } };
}
