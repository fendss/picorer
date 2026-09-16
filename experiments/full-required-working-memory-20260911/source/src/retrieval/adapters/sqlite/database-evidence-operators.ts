import type { DatabaseSync } from "node:sqlite";
import {
  EVIDENCE_FACT_EXTRACTOR_VERSION,
  EvidenceFactIndex,
  type EvidenceFactIndexStatus,
} from "./evidence-fact-index.js";
import type {
  EvidenceOperatorSearchContext,
  SearchRequest,
} from "../../model/search.js";
import type { MemoryRecord } from "../../../memory/index.js";
import { queryCenteredEpisodicPreview } from "../../../util.js";
import { compareMemoryChronology, parseSourceTimestamp } from "../../model/source-time.js";
import { finalizeSearchHits } from "../../finalize-search-hits.js";
import {
  type MemoryRow,
  memoryRowToRecord,
} from "../../../platform/sqlite/memory-row.js";

interface TemporalFactRow extends MemoryRow {
  span_start: number;
  span_end: number;
  expression: string;
  resolved_date: string;
  basis: string;
}

interface NumericFactRow extends MemoryRow {
  fact_index: number;
  span_start: number;
  span_end: number;
}

export interface DatabaseOperatorSeed {
  record: MemoryRecord;
  query?: string;
  matchedQueries?: readonly string[];
}

function sessionQueryPaths(seeds: readonly DatabaseOperatorSeed[]): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const queries = paths.get(seed.record.sessionId) ?? new Set<string>();
    for (const query of seed.matchedQueries ?? (seed.query === undefined ? [] : [seed.query])) queries.add(query);
    paths.set(seed.record.sessionId, queries);
  }
  return paths;
}

export interface DatabaseOperatorHit {
  record: MemoryRecord;
  query: string;
  matchedQueries: string[];
  retriever: "picorer-timeline-db" | "picorer-aggregate-db";
  rank: number;
  score: number;
  preview: string;
  operatorSourceSpans?: Array<{ start: number; end: number }>;
  operatorNumericFactIndexes?: number[];
  operatorTemporalFacts?: Array<{
    expression: string;
    resolvedDate: string;
    basis: string;
  }>;
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return compareMemoryChronology(left, right);
}

const OPERATOR_STOP_WORDS = new Set([
  "about", "after", "again", "all", "and", "before", "did", "does",
  "for", "from", "have", "how", "many", "much", "of", "the", "then",
  "total", "was", "were", "what", "when", "which", "with",
]);

function operatorTokens(queries: readonly string[]): string[] {
  const tokens = queries
    .join(" ")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  return [...new Set(tokens.filter((token) =>
    token.length > 2 && !OPERATOR_STOP_WORDS.has(token)
  ))];
}

/**
 * Owns all deterministic, database-backed evidence indexing and expansion.
 * It never mutates raw memories; every table below is a versioned sidecar.
 */
export class DatabaseEvidenceOperators {
  private readonly db: DatabaseSync;
  private readonly factIndex: EvidenceFactIndex;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.factIndex = new EvidenceFactIndex(db);
  }

  /** Lazily materializes facts for one scope and is idempotent. */
  ensureScope(scopeId: string): EvidenceFactIndexStatus {
    return this.factIndex.ensureScope(scopeId);
  }

  expand(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly DatabaseOperatorSeed[],
  ): DatabaseOperatorHit[] {
    if (request.roles?.length === 0 || request.sessionIds?.length === 0) return [];
    this.ensureScope(scopeId);
    return context.operator === "temporal"
      ? this.expandTimeline(scopeId, request, context, seedHits)
      : this.expandAggregate(scopeId, request, context, seedHits);
  }

  private matchesRequestFilters(
    record: MemoryRecord,
    request: SearchRequest,
  ): boolean {
    if (request.sessionIds && !request.sessionIds.includes(record.sessionId)) {
      return false;
    }
    if (request.roles && !request.roles.includes(record.role)) return false;
    const time = parseSourceTimestamp(record.timestamp);
    const after = parseSourceTimestamp(request.after);
    const before = parseSourceTimestamp(request.before);
    if (request.after && (time === undefined || after === undefined || time < after)) {
      return false;
    }
    if (request.before && (time === undefined || before === undefined || time > before)) {
      return false;
    }
    return true;
  }

  private hit(
    record: MemoryRecord,
    query: string,
    matchedQueries: readonly string[],
    retriever: DatabaseOperatorHit["retriever"],
    rank: number,
  ): DatabaseOperatorHit {
    return {
      record,
      query,
      matchedQueries: [...matchedQueries],
      retriever,
      rank,
      score: 1 / (60 + rank),
      preview: queryCenteredEpisodicPreview(record.content, query),
    };
  }

  private expandTimeline(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly DatabaseOperatorSeed[],
  ): DatabaseOperatorHit[] {
    const rows = this.db.prepare(`
      SELECT m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
             m.content, m.timestamp, m.content_hash, m.metadata_json,
             t.span_start, t.span_end, t.expression, t.resolved_date, t.basis
      FROM memory_temporal_facts AS t
      JOIN memories AS m ON m.memory_id = t.memory_id
      WHERE t.scope_id = ? AND t.extractor_version = ?
      ORDER BY t.resolved_date ASC, m.session_id ASC, m.turn_index ASC
    `).iterate(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as Iterable<TemporalFactRow>;
    const targetDates = new Set([
      ...(context.targetDates ?? []),
      ...request.queries.flatMap((query) =>
        query.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
      ),
    ]);
    const seedSessions = new Set(seedHits.map((hit) => hit.record.sessionId));
    const seedPaths = sessionQueryPaths(seedHits);
    const seedMemories = new Set(seedHits.map((hit) => hit.record.memoryId));
    const seedOrder = new Map(seedHits.map((hit, index) => [hit.record.memoryId, index]));
    const grouped = new Map<string, {
      record: MemoryRecord;
      dates: Set<string>;
      facts: Map<string, {
        expression: string;
        resolvedDate: string;
        basis: string;
      }>;
      sourceSpans: Map<string, { start: number; end: number }>;
    }>();
    const {
      after: _ignoredAfter,
      before: _ignoredBefore,
      ...timelineFilters
    } = request;

    for (const row of rows) {
      const record = grouped.get(row.memory_id)?.record ?? memoryRowToRecord(row);
      // Resolved target dates, not model-supplied bounds, drive this expansion.
      if (!this.matchesRequestFilters(record, timelineFilters)) continue;
      const entry = grouped.get(record.memoryId) ?? {
        record,
        dates: new Set<string>(),
        facts: new Map(),
        sourceSpans: new Map(),
      };
      entry.dates.add(row.resolved_date);
      entry.facts.set(
        `${row.expression}\0${row.resolved_date}\0${row.basis}`,
        {
          expression: row.expression,
          resolvedDate: row.resolved_date,
          basis: row.basis,
        },
      );
      if (row.span_start >= 0 && row.span_end > row.span_start) {
        entry.sourceSpans.set(`${String(row.span_start)}:${String(row.span_end)}`, {
          start: row.span_start,
          end: row.span_end,
        });
      }
      grouped.set(record.memoryId, entry);
    }

    const ranked = [...grouped.values()]
      .map((entry) => {
        const targetMatch = [...entry.dates].some((date) => targetDates.has(date));
        const seedMemory = seedMemories.has(entry.record.memoryId);
        const seedSession = seedSessions.has(entry.record.sessionId);
        return {
          ...entry,
          targetMatch,
          seedSession,
          seedOrder: seedOrder.get(entry.record.memoryId) ?? Number.MAX_SAFE_INTEGER,
          priority: targetMatch && seedMemory
            ? 0
            : targetMatch && seedSession
              ? 1
              : targetMatch
                ? 2
                : seedMemory
                  ? 3
                  : seedSession
                    ? 4
                    : 5,
        };
      })
      .filter((entry) => entry.targetMatch || entry.seedSession)
      .sort((left, right) => {
        const priority = left.priority - right.priority;
        if (priority !== 0) return priority;
        const relevance = left.seedOrder - right.seedOrder;
        return relevance !== 0 ? relevance : compareRecords(left.record, right.record);
      });
    const query = targetDates.size === 0
      ? "database timeline expansion"
      : `database timeline dates ${[...targetDates].join(",")}`;
    const hits = ranked.map((entry, index) => ({
      ...this.hit(
        entry.record,
        query,
        request.queries.filter((query) => seedPaths.get(entry.record.sessionId)?.has(query) ||
          (query.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []).some((date) => entry.dates.has(date))),
        "picorer-timeline-db",
        index + 1,
      ),
      operatorTemporalFacts: [...entry.facts.values()],
      ...(entry.sourceSpans.size === 0
        ? {}
        : { operatorSourceSpans: [...entry.sourceSpans.values()] }),
    }));
    return finalizeSearchHits(hits, request, context.maxCandidates);
  }

  private expandAggregate(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly DatabaseOperatorSeed[],
  ): DatabaseOperatorHit[] {
    const rows = this.db.prepare(`
      SELECT
        m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
        m.content, m.timestamp, m.content_hash, m.metadata_json,
        n.fact_index, n.span_start, n.span_end
      FROM memory_numeric_facts AS n
      JOIN memories AS m ON m.memory_id = n.memory_id
      WHERE n.scope_id = ? AND n.extractor_version = ?
      ORDER BY m.timestamp IS NULL ASC, m.timestamp ASC,
               m.session_id ASC, m.turn_index ASC, n.fact_index ASC
    `).iterate(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as Iterable<NumericFactRow>;
    const seedSessions = new Set(seedHits.map((hit) => hit.record.sessionId));
    const seedPaths = sessionQueryPaths(seedHits);
    const seedMemories = new Set(seedHits.map((hit) => hit.record.memoryId));
    const tokens = operatorTokens(request.queries);
    const queryTokens = request.queries.map((query) => ({ query, tokens: operatorTokens([query]) }));
    const grouped = new Map<string, {
      record: MemoryRecord;
      factIndexes: number[];
      sourceSpans: Map<string, { start: number; end: number }>;
      overlap: number;
      seedMemory: boolean;
      seedSession: boolean;
      queryPaths: Set<string>;
    }>();

    for (const row of rows) {
      const record = grouped.get(row.memory_id)?.record ?? memoryRowToRecord(row);
      if (!this.matchesRequestFilters(record, request)) continue;
      const localContext = record.content
        .slice(
          Math.max(0, row.span_start - 140),
          Math.min(record.content.length, row.span_end + 140),
        )
        .normalize("NFKC")
        .toLowerCase();
      const overlap = tokens.filter((token) => localContext.includes(token)).length;
      const seedMemory = seedMemories.has(record.memoryId);
      const seedSession = seedSessions.has(record.sessionId);
      if (!seedMemory && !seedSession && overlap === 0) continue;
      const entry = grouped.get(record.memoryId) ?? {
        record,
        factIndexes: [] as number[],
        sourceSpans: new Map<string, { start: number; end: number }>(),
        overlap: 0,
        seedMemory,
        seedSession,
        queryPaths: new Set(request.queries.filter((query) => seedPaths.get(record.sessionId)?.has(query))),
      };
      for (const path of queryTokens) {
        if (path.tokens.some((token) => localContext.includes(token))) entry.queryPaths.add(path.query);
      }
      entry.factIndexes.push(row.fact_index);
      entry.sourceSpans.set(`${String(row.span_start)}:${String(row.span_end)}`, {
        start: row.span_start,
        end: row.span_end,
      });
      entry.overlap = Math.max(entry.overlap, overlap);
      grouped.set(record.memoryId, entry);
    }

    const ranked = [...grouped.values()]
      .map((entry) => ({
        ...entry,
        priority: entry.seedMemory
          ? 0
          : entry.seedSession && entry.overlap > 0
            ? 1
            : entry.overlap > 0
              ? 2
              : 3,
      }))
      .sort((left, right) => {
        const priority = left.priority - right.priority;
        if (priority !== 0) return priority;
        const overlap = right.overlap - left.overlap;
        if (overlap !== 0) return overlap;
        const role = (left.record.role === "user" ? 0 : 1) -
          (right.record.role === "user" ? 0 : 1);
        return role !== 0 ? role : compareRecords(left.record, right.record);
      });

    const hits = ranked.map((entry, index) => ({
      ...this.hit(
        entry.record,
        `database numeric facts for ${request.queries.join(" | ")}`,
        request.queries.filter((query) => entry.queryPaths.has(query)),
        "picorer-aggregate-db",
        index + 1,
      ),
      operatorNumericFactIndexes: entry.factIndexes,
      operatorSourceSpans: [...entry.sourceSpans.values()],
    }));
    return finalizeSearchHits(hits, request, context.maxCandidates);
  }
}
