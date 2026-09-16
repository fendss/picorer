import type { RetrievalHit, SearchRequest } from "./model/search.js";

import { compareMemoryChronology } from "./model/source-time.js";

export function finalizeSearchHits<T extends RetrievalHit>(
  relevanceOrderedHits: readonly T[],
  request: SearchRequest,
  limit: number,
): T[] {
  const chronological = request.order === "chronological" || request.order === "reverse-chronological";
  const compare = (left: RetrievalHit, right: RetrievalHit) => compareMemoryChronology(
    left.record, right.record, request.order === "reverse-chronological" ? -1 : 1,
  );
  const ordered = chronological ? [...relevanceOrderedHits].sort(compare) : relevanceOrderedHits;
  const selected = request.maxPerSession === undefined
    ? ordered.slice(0, limit)
    : selectSessionBreadth(ordered, request.maxPerSession, limit);
  if (chronological) selected.sort(compare);
  return selected.map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/**
 * Breadth-first admission only when the caller explicitly asks for a session
 * cap. Later rounds preserve useful depth within strong sessions; in
 * particular this does not collapse a conversation to one event unless the
 * caller chose maxPerSession=1.
 */
function selectSessionBreadth<T extends RetrievalHit>(
  relevanceOrderedHits: readonly T[],
  maxPerSession: number,
  limit: number,
): T[] {
  const sessions = new Map<string, T[]>();
  for (const hit of relevanceOrderedHits) {
    const session = sessions.get(hit.record.sessionId) ?? [];
    session.push(hit);
    sessions.set(hit.record.sessionId, session);
  }
  const selected: T[] = [];
  for (let depth = 0; depth < maxPerSession; depth += 1) {
    let progressed = false;
    for (const session of sessions.values()) {
      const hit = session[depth];
      if (hit === undefined) continue;
      selected.push(hit);
      progressed = true;
      if (selected.length >= limit) return selected;
    }
    if (!progressed) break;
  }
  return selected;
}
