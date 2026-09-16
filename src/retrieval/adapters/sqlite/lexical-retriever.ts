import type { DatabaseSync } from "node:sqlite";
import {
  type MemoryRow,
  memoryRowToRecord,
} from "../../../platform/sqlite/memory-row.js";
import { finalizeSearchHits } from "../../finalize-search-hits.js";
import type { RetrievalHit, SearchRequest } from "../../model/search.js";
import { tokenizeForPicorerHybrid } from "../../ranking.js";
import { queryCenteredEpisodicPreview } from "../../../util.js";

interface SearchRow extends MemoryRow {
  rank: number;
}

interface FtsQueryPlan {
  match: string;
  weight: number;
}

const LEXICAL_RRF_K = 60;
const MULTI_QUERY_COVERAGE_WEIGHT = 0.25;

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

function rawFtsTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)
      ?.slice(0, 24) ?? []
  );
}

/** Builds strict-to-broad FTS plans from query text alone. */
function ftsQueryPlans(text: string): FtsQueryPlan[] {
  const rawTokens = rawFtsTokens(text);
  if (rawTokens.length === 0) return [];
  const informativeTokens = tokenizeForPicorerHybrid(text).slice(0, 24);
  const recallTokens = [...new Set(informativeTokens.length === 0
    ? rawTokens.map((token) => token.toLowerCase())
    : informativeTokens)];
  const plans: FtsQueryPlan[] = [];
  if (rawTokens.length > 1) {
    plans.push({
      match: quoteFtsToken(rawTokens.join(" ")),
      weight: 1.2,
    });
  }
  const anchors = recallTokens.slice(0, 6);
  if (anchors.length > 1) {
    plans.push({
      match: anchors.map(quoteFtsToken).join(" AND "),
      weight: 1.1,
    });
  }
  plans.push({
    match: recallTokens.map(quoteFtsToken).join(" OR "),
    weight: 1,
  });
  const unique = new Map<string, FtsQueryPlan>();
  for (const plan of plans) {
    if (!unique.has(plan.match)) unique.set(plan.match, plan);
  }
  return [...unique.values()];
}

/** SQLite FTS adapter; query planning and ranking stay inside retrieval. */
export class SqliteLexicalRetriever {
  constructor(private readonly db: DatabaseSync) {}

  search(scopeId: string, request: SearchRequest): RetrievalHit[] {
    if (request.roles?.length === 0 || request.sessionIds?.length === 0) return [];
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    // Fusion needs the same bounded physical pool regardless of visible depth.
    const fetchLimit = 100;
    const merged = new Map<string, {
      hit: RetrievalHit;
      bestScore: number;
      totalScore: number;
      queries: Set<string>;
    }>();
    const queryRankings: RetrievalHit[][] = [];

    for (const query of request.queries) {
      const queryHits = new Map<string, RetrievalHit>();
      for (const plan of ftsQueryPlans(query)) {
        const where: string[] = [
          "memory_fts MATCH ?",
          "memory_fts.scope_id = ?",
        ];
        const params: Array<string | number> = [plan.match, scopeId];

        if (request.sessionIds && request.sessionIds.length > 0) {
          where.push(
            `m.session_id IN (${request.sessionIds.map(() => "?").join(", ")})`,
          );
          params.push(...request.sessionIds);
        }
        if (request.roles && request.roles.length > 0) {
          where.push(`m.role IN (${request.roles.map(() => "?").join(", ")})`);
          params.push(...request.roles);
        }
        if (request.after) {
          where.push("julianday(m.timestamp) >= julianday(?)");
          params.push(request.after);
        }
        if (request.before) {
          where.push("julianday(m.timestamp) <= julianday(?)");
          params.push(request.before);
        }
        params.push(fetchLimit);

        const rows = this.db.prepare(`
          SELECT
            m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
            m.content, m.timestamp, m.content_hash, m.metadata_json,
            bm25(memory_fts, 1.0) AS rank
          FROM memory_fts
          JOIN memories AS m ON m.memory_id = memory_fts.memory_id
          WHERE ${where.join(" AND ")}
          ORDER BY rank ASC, m.memory_id ASC
          LIMIT ?
        `).all(...params) as unknown as SearchRow[];
        rows.forEach((row, index) => {
          const contribution = plan.weight / (LEXICAL_RRF_K + index + 1);
          const existing = queryHits.get(row.memory_id);
          if (existing === undefined) {
            queryHits.set(row.memory_id, {
              record: memoryRowToRecord(row),
              query,
              retriever: "fts5",
              rank: 0,
              score: contribution,
              preview: queryCenteredEpisodicPreview(row.content, query),
            });
          } else {
            existing.score += contribution;
          }
        });
      }
      const rankedForQuery = [...queryHits.values()]
        .sort((left, right) =>
          right.score - left.score ||
          left.record.memoryId.localeCompare(right.record.memoryId)
        )
        .slice(0, fetchLimit)
        .map((hit, index) => ({ ...hit, rank: index + 1 }));
      queryRankings.push(rankedForQuery);
      for (const hit of rankedForQuery) {
        const existing = merged.get(hit.record.memoryId);
        if (existing === undefined) {
          merged.set(hit.record.memoryId, {
            hit,
            bestScore: hit.score,
            totalScore: hit.score,
            queries: new Set([query]),
          });
          continue;
        }
        if (!existing.queries.has(query)) {
          existing.queries.add(query);
          existing.totalScore += hit.score;
        }
        if (hit.score > existing.bestScore) {
          existing.hit = hit;
          existing.bestScore = hit.score;
        }
      }
    }

    const ranked = [...merged.values()]
      .map((entry) => ({
        ...entry.hit,
        matchedQueries: [...entry.queries],
        score:
          entry.bestScore +
          MULTI_QUERY_COVERAGE_WEIGHT * (entry.totalScore - entry.bestScore),
      }))
      .sort((left, right) =>
        right.score - left.score ||
        left.record.memoryId.localeCompare(right.record.memoryId)
      );
    const reservedCoverage: RetrievalHit[] = [];
    if (request.queries.length > 1) {
      const reservationLimit = Math.min(10, request.queries.length);
      const reservedIds = new Set<string>();
      for (const queryRanking of queryRankings) {
        const hit = queryRanking.find((candidate) =>
          !reservedIds.has(candidate.record.memoryId)
        );
        if (hit === undefined) continue;
        reservedCoverage.push({
          ...hit,
          matchedQueries: [...merged.get(hit.record.memoryId)!.queries],
        });
        reservedIds.add(hit.record.memoryId);
        if (reservedCoverage.length >= reservationLimit) break;
      }
    }
    const unique = new Map<string, RetrievalHit>();
    for (const hit of [...reservedCoverage, ...ranked]) {
      if (!unique.has(hit.record.memoryId)) unique.set(hit.record.memoryId, hit);
    }
    return finalizeSearchHits([...unique.values()], request, limit);
  }
}
