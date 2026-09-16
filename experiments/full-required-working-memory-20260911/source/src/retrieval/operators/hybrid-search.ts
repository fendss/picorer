import type { Embedder } from "../model/embedder.js";
import { embeddingProfile } from "../index-scope-embeddings.js";
import { reciprocalRankFusion } from "../ranking.js";
import { finalizeSearchHits } from "../finalize-search-hits.js";
import type {
  EvidenceOperatorSearchContext,
  RetrievalHit,
  RetrievalMetadataFilter,
  RetrievalMetadata,
  RetrievalMetricsSnapshot,
  SearchRequest,
} from "../model/search.js";
import type {
  DenseRetriever,
  DenseSearchHit,
} from "../ports/dense-retriever.js";
import type { HybridSearchStore } from "../ports/hybrid-search-store.js";
import type { MemoryRecord } from "../../memory/index.js";
import { queryCenteredEpisodicPreview } from "../../util.js";
import { searchExplicitDateRoutes } from "../search-explicit-date-routes.js";

interface RankedHybridHit extends RetrievalHit {
  denseRank: number;
  lexicalRank: number;
  queryIndex: number;
}

interface AggregatedHybridHit {
  hit: RankedHybridHit;
  bestScore: number;
  totalScore: number;
  queryIndexes: Set<number>;
}

const MULTI_QUERY_COVERAGE_WEIGHT = 0.25;
const MAX_METADATA_ROUTE_RESERVATIONS = 4;
const MAX_QUERY_COVERAGE_RESERVATIONS = 10;
const QUERY_LOCAL_RESERVOIR_LIMIT = 100;

function metadataFilterKey(filter: RetrievalMetadataFilter): string {
  return JSON.stringify([
    filter.source,
    filter.query,
    filter.after,
    filter.before,
  ]);
}

function mergeMetadataFilters(
  ...groups: Array<readonly RetrievalMetadataFilter[] | undefined>
): RetrievalMetadataFilter[] | undefined {
  const merged = new Map<string, RetrievalMetadataFilter>();
  for (const filter of groups.flatMap((group) => group ?? [])) {
    merged.set(metadataFilterKey(filter), filter);
  }
  return merged.size === 0 ? undefined : [...merged.values()];
}

function reserveMetadataRoutes<T extends RetrievalHit>(
  rankings: readonly (readonly T[])[],
): T[] {
  const reserved: T[] = [];
  const seen = new Set<string>();
  for (let depth = 0; reserved.length < MAX_METADATA_ROUTE_RESERVATIONS; depth += 1) {
    let progressed = false;
    for (const ranking of rankings) {
      const hit = ranking[depth];
      if (hit === undefined) continue;
      progressed = true;
      if (seen.has(hit.record.memoryId)) continue;
      reserved.push(hit);
      seen.add(hit.record.memoryId);
      if (reserved.length >= MAX_METADATA_ROUTE_RESERVATIONS) break;
    }
    if (!progressed) break;
  }
  return reserved;
}

function compareFinal(left: RankedHybridHit, right: RankedHybridHit): number {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const denseRank = left.denseRank - right.denseRank;
  if (denseRank !== 0) return denseRank;
  const lexicalRank = left.lexicalRank - right.lexicalRank;
  if (lexicalRank !== 0) return lexicalRank;
  return left.record.memoryId.localeCompare(right.record.memoryId);
}

export class HybridRetriever {
  readonly rawStore: HybridSearchStore;
  readonly embedder: Embedder;
  readonly denseRetriever: DenseRetriever;

  private denseCandidateCount = 0;
  private rerankCandidateCount = 0;

  constructor(
    rawStore: HybridSearchStore,
    embedder: Embedder,
    denseRetriever: DenseRetriever,
  ) {
    this.rawStore = rawStore;
    this.embedder = embedder;
    this.denseRetriever = denseRetriever;
  }

  getRetrievalMetadata(): RetrievalMetadata {
    return {
      retrievalProfile: this.denseRetriever.retrievalProfile,
      embeddingProfileId: this.embedder.profileId,
      embeddingModel: this.embedder.model,
      embeddingDimensions: this.embedder.dimensions,
      ...(this.denseRetriever.vectorGenerationId === undefined
        ? {}
        : { vectorGenerationId: this.denseRetriever.vectorGenerationId }),
      ...(this.denseRetriever.vectorCollection === undefined
        ? {}
        : { vectorCollection: this.denseRetriever.vectorCollection }),
      ...(this.denseRetriever.vectorSearch === undefined
        ? {}
        : { vectorSearch: structuredClone(this.denseRetriever.vectorSearch) }),
    };
  }

  snapshotRetrievalMetrics(): RetrievalMetricsSnapshot {
    const embedding = this.embedder.snapshotMetrics();
    return {
      embeddingCalls: embedding.calls,
      embeddingLatencyMs: embedding.latencyMs,
      denseCandidateCount: this.denseCandidateCount,
      rerankCandidateCount: this.rerankCandidateCount,
      denseFallbackCount: this.denseRetriever.snapshotFallbackCount?.() ?? 0,
    };
  }

  async search(
    scopeId: string,
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<RetrievalHit[]> {
    signal?.throwIfAborted();
    if (request.roles?.length === 0 || request.sessionIds?.length === 0) return [];
    const profile = embeddingProfile(this.embedder);
    const status = this.rawStore.getEmbeddingIndexStatus(scopeId, profile);
    if (status.total === 0) {
      return [];
    }
    if (status.missing !== 0) {
      throw new Error(
        `Hybrid embedding index is incomplete for scope ${scopeId}: ` +
          `${status.indexed}/${status.total} indexed`,
      );
    }

    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const queryVectors =
      signal === undefined
        ? await this.embedder.embedQueries(request.queries)
        : await this.embedder.embedQueries(request.queries, { signal });
    if (queryVectors.length !== request.queries.length) {
      throw new Error("Query embedding count does not match query count");
    }
    // Physical ranking must not depend on the visible page size: otherwise a
    // continuation reorders candidates that were already shown.
    const headroom = QUERY_LOCAL_RESERVOIR_LIMIT;
    // Query-local discovery is intentionally wider than the visible result.
    // Selection and observation remain bounded by the request limit below.
    const perQueryLimit = headroom;
    const merged = new Map<string, AggregatedHybridHit>();
    const queryRankings: RankedHybridHit[][] = [];
    const metadataRouteRankings: RankedHybridHit[][] = [];
    const denseRequest = {
      scopeId,
      profile,
      queryVectors,
      limit: headroom,
      filters: {
        ...(request.sessionIds === undefined
          ? {}
          : { sessionIds: request.sessionIds }),
        ...(request.roles === undefined ? {} : { roles: request.roles }),
        ...(request.after === undefined ? {} : { after: request.after }),
        ...(request.before === undefined ? {} : { before: request.before }),
      },
      ...(signal === undefined ? {} : { signal }),
    };
    const baseDenseRankings = this.denseRetriever.search(denseRequest).then(
      (rankings) => {
        if (rankings.length !== request.queries.length) {
          throw new Error("Dense ranking count does not match query count");
        }
        return rankings;
      },
    );
    const dateRoutes = searchExplicitDateRoutes(
      this.denseRetriever, denseRequest, request.queries,
    );
    const rankedQueries = await Promise.all(request.queries.map(async (
      query,
      queryIndex,
    ) => {
      const {
        maxPerSession: _ignoredMaxPerSession,
        order: _ignoredOrder,
        ...lexicalBase
      } = request;
      const rankRoute = async (
        routeRequest: SearchRequest,
        denseCandidatesPromise: Promise<readonly DenseSearchHit[]>,
        metadataFilter?: RetrievalMetadataFilter,
      ): Promise<RankedHybridHit[]> => {
        const [denseCandidates, lexicalHits] = await Promise.all([
          denseCandidatesPromise,
          Promise.resolve(this.rawStore.search(scopeId, routeRequest)),
        ]);
        this.denseCandidateCount += denseCandidates.length;

        const union = new Map<string, { record: MemoryRecord }>();
        for (const candidate of denseCandidates) {
          union.set(candidate.record.memoryId, { record: candidate.record });
        }
        for (const hit of lexicalHits) {
          if (!union.has(hit.record.memoryId)) {
            union.set(hit.record.memoryId, { record: hit.record });
          }
        }
        const candidates = [...union.values()];
        this.rerankCandidateCount += candidates.length;
        const indexes = new Map(
          candidates.map((candidate, index) => [candidate.record.memoryId, index]),
        );
        const denseRanking = denseCandidates.map((candidate) =>
          indexes.get(candidate.record.memoryId)!
        );
        const lexicalRanking = lexicalHits.map((hit) =>
          indexes.get(hit.record.memoryId)!
        );
        const fused = reciprocalRankFusion(
          [denseRanking, lexicalRanking],
          60,
          candidates.length,
        );
        const denseRanks = new Map(
          denseRanking.map((candidateIndex, index) => [candidateIndex, index + 1]),
        );
        const lexicalRanks = new Map(
          lexicalRanking.map((candidateIndex, index) => [candidateIndex, index + 1]),
        );
        return candidates
          .map((candidate, index) => ({
            record: candidate.record,
            query,
            retriever: "picorer-hybrid" as const,
            rank: 0,
            score: fused[index]!,
            preview: queryCenteredEpisodicPreview(candidate.record.content, query),
            denseRank: denseRanks.get(index) ?? Number.MAX_SAFE_INTEGER,
            lexicalRank: lexicalRanks.get(index) ?? Number.MAX_SAFE_INTEGER,
            queryIndex,
            ...(metadataFilter === undefined
              ? {}
              : { matchedMetadataFilters: [metadataFilter] }),
          }))
          .sort(compareFinal)
          .slice(0, headroom)
          .map((hit, index) => ({ ...hit, rank: index + 1 }));
      };

      const baseRankingPromise = rankRoute(
        {
          ...lexicalBase,
          queries: [query],
          limit: Math.min(100, headroom),
          order: "relevance",
        },
        baseDenseRankings.then((rankings) => rankings[queryIndex]!),
      );
      const dateRoute = dateRoutes.get(queryIndex);
      const dateFilter = dateRoute?.filter;
      const dateRankingPromise = dateFilter === undefined
        ? Promise.resolve<RankedHybridHit[] | undefined>(undefined)
        : rankRoute(
            {
              ...lexicalBase,
              queries: [query],
              limit: Math.min(100, headroom),
              order: "relevance",
              after: dateFilter.after,
              before: dateFilter.before,
            },
            dateRoute!.ranking,
            dateFilter,
          );
      const [baseRanking, dateRanking] = await Promise.all([
        baseRankingPromise,
        dateRankingPromise,
      ]);
      // The constrained route only receives explicit reservation slots below.
      // Base scores and ordering remain byte-for-byte independent of it.
      return { queryIndex, queryHits: baseRanking.slice(0, perQueryLimit), dateRanking };
    }));

    for (const { queryIndex, queryHits, dateRanking } of rankedQueries) {
      if (dateRanking !== undefined && dateRanking.length > 0) {
        metadataRouteRankings.push(dateRanking);
      }
      queryRankings.push(queryHits);
      for (const hit of queryHits) {
        const existing = merged.get(hit.record.memoryId);
        if (existing === undefined) {
          merged.set(hit.record.memoryId, {
            hit,
            bestScore: hit.score,
            totalScore: hit.score,
            queryIndexes: new Set([queryIndex]),
          });
          continue;
        }
        if (!existing.queryIndexes.has(queryIndex)) {
          existing.queryIndexes.add(queryIndex);
          existing.totalScore += hit.score;
        }
        const filters = mergeMetadataFilters(
          existing.hit.matchedMetadataFilters,
          hit.matchedMetadataFilters,
        );
        if (
          hit.score > existing.bestScore ||
          (hit.score === existing.bestScore &&
            hit.denseRank < existing.hit.denseRank) ||
          (hit.score === existing.bestScore &&
            hit.denseRank === existing.hit.denseRank &&
            hit.lexicalRank < existing.hit.lexicalRank)
        ) {
          existing.hit = {
            ...hit,
            ...(filters === undefined ? {} : { matchedMetadataFilters: filters }),
          };
          existing.bestScore = hit.score;
        } else if (filters !== undefined) {
          existing.hit = {
            ...existing.hit,
            matchedMetadataFilters: filters,
          };
        }
      }
    }

    const aggregated = [...merged.values()]
      .map((entry) => ({
        ...entry.hit,
        matchedQueries: [...entry.queryIndexes]
          .sort((left, right) => left - right)
          .map((queryIndex) => request.queries[queryIndex]!),
        score:
          entry.bestScore +
          MULTI_QUERY_COVERAGE_WEIGHT * (entry.totalScore - entry.bestScore),
      }))
      .sort(compareFinal);
    const reservedCoverage: RankedHybridHit[] = [];
    if (request.queries.length > 1) {
      const reservationLimit = Math.min(
        MAX_QUERY_COVERAGE_RESERVATIONS,
        request.queries.length,
      );
      const reservedIds = new Set<string>();
      for (const queryRanking of queryRankings) {
        const hit = queryRanking.find((candidate) =>
          !reservedIds.has(candidate.record.memoryId)
        );
        if (hit === undefined) continue;
        const queryIndexes = merged.get(hit.record.memoryId)?.queryIndexes;
        reservedCoverage.push({
          ...hit,
          matchedQueries: queryIndexes === undefined
            ? [hit.query]
            : [...queryIndexes]
              .sort((left, right) => left - right)
              .map((queryIndex) => request.queries[queryIndex]!),
        });
        reservedIds.add(hit.record.memoryId);
        if (reservedCoverage.length >= reservationLimit) break;
      }
    }
    const metadataCoverage = reserveMetadataRoutes(metadataRouteRankings);
    const ordered = [
      ...metadataCoverage,
      ...reservedCoverage,
      ...aggregated,
    ];
    const unique = new Map<string, RetrievalHit>();
    for (const {
      denseRank: _denseRank,
      lexicalRank: _lexicalRank,
      queryIndex: _queryIndex,
      ...hit
    } of ordered) {
      const existing = unique.get(hit.record.memoryId);
      if (existing === undefined) {
        unique.set(hit.record.memoryId, hit);
        continue;
      }
      const filters = mergeMetadataFilters(
        existing.matchedMetadataFilters,
        hit.matchedMetadataFilters,
      );
      unique.set(hit.record.memoryId, {
        ...existing,
        matchedQueries: [...new Set([
          ...(existing.matchedQueries ?? [existing.query]),
          ...(hit.matchedQueries ?? [hit.query]),
        ])],
        ...(filters === undefined ? {} : { matchedMetadataFilters: filters }),
      });
    }
    return finalizeSearchHits([...unique.values()], request, limit);
  }

  searchLexical(
    scopeId: string,
    request: SearchRequest,
  ): RetrievalHit[] {
    return this.rawStore.search(scopeId, request);
  }

  expandEvidenceOperator(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly RetrievalHit[],
  ): RetrievalHit[] {
    return this.rawStore.expandEvidenceOperator(
      scopeId,
      request,
      context,
      seedHits,
    );
  }

  read(
    scopeId: string,
    memoryIds: string[],
    contextBefore = 0,
    contextAfter = 0,
  ): MemoryRecord[] {
    return this.rawStore.read(
      scopeId,
      memoryIds,
      contextBefore,
      contextAfter,
    );
  }

  getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[] {
    return this.rawStore.getRecords(scopeId, memoryIds);
  }

  findMentionedMemoryIds(scopeId: string, text: string): string[] {
    return this.rawStore.findMentionedMemoryIds(scopeId, text);
  }
}
