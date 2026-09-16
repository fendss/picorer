import { searchQueryFingerprint } from "../model/search.js";
import type {
  EvidenceOperatorResult,
  RetrievalHit,
  SearchOrder,
  SearchRequest,
} from "../model/search.js";
import type {
  SearchOperatorCombineMethod,
  SearchOperatorCompositionTrace,
  SearchOperatorDefinition,
  SearchOperatorInput,
} from "../model/operator.js";
import { projectSearchHitsToPassages } from "../model/passage.js";
import type { MemoryRole } from "../../memory/index.js";
import { buildDeclarativeSearchOperator } from "./compose-operator.js";
import { executeSearchOperator } from "./execute-operator.js";
import type { SearchOperatorCatalog } from "../ports/operator-catalog.js";
import { queryCenteredEpisodicPreview } from "../../util.js";

export interface SearchMemoryBranch {
  operator: string;
  queries: string[];
}

export interface SearchMemoryParams {
  operator?: string;
  queries: string[];
  branches?: SearchMemoryBranch[];
  combine?: SearchOperatorCombineMethod;
  roles?: MemoryRole[];
  order?: SearchOrder;
  maxPerSession?: number;
  limit?: number;
}

export interface SearchMemoryResult {
  request: SearchRequest;
  /** Actual primitive query paths, including fixed queries inside a plan. */
  executedQueries: string[];
  operator: string;
  operatorVersion: string;
  hits: RetrievalHit[];
  operatorResult?: EvidenceOperatorResult;
  composition?: SearchOperatorCompositionTrace;
  repeatedQueries: string[];
  /** Harness-owned physical pool for bounded full pages and compact navigation. */
  reservoir?: {
    hits: RetrievalHit[];
    limit: number;
    exhausted: boolean;
  };
}

interface SearchMemoryOptions {
  operatorRegistry: SearchOperatorCatalog;
  scopeId: string;
  /** Experimental query-local passage projection. Parent candidates remain the default. */
  passageProjection?: boolean;
  question?: string;
  questionDate?: string;
  searchDefaults?: Pick<SearchRequest, "limit" | "order" | "maxPerSession">;
  /** Internal physical depth; never changes the Agent-visible page size. */
  candidateReservoirLimit?: number;
}

function normalizeStrings(values: readonly string[], label: string): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  if (normalized.length === 0) {
    throw new Error(`${label} must contain at least one non-empty value`);
  }
  return normalized;
}

function operatorSourceQuotes(
  result: EvidenceOperatorResult | undefined,
): Map<string, string[]> {
  const quotes = new Map<string, string[]>();
  for (const row of result?.rows ?? []) {
    const values = quotes.get(row.memoryId) ?? [];
    if (!values.includes(row.quote)) values.push(row.quote);
    quotes.set(row.memoryId, values);
  }
  return quotes;
}

function inlineSearchDefinition(
  params: SearchMemoryParams,
  primaryOperator: string,
): SearchOperatorDefinition | undefined {
  const branches = params.branches ?? [];
  const needsPlan = branches.length > 0 ||
    (params.order !== undefined && params.order !== "relevance") ||
    params.roles !== undefined ||
    params.maxPerSession !== undefined;
  if (!needsPlan) return undefined;

  const sources = [
    { operator: primaryOperator, queries: params.queries },
    ...branches,
  ];
  const steps: SearchOperatorDefinition["steps"] = sources.map(
    (source, index) => ({
      id: `source-${String(index + 1)}`,
      kind: "search",
      operator: source.operator,
      queries: [...source.queries],
    }),
  );
  let output = steps.at(-1)!.id;
  if (sources.length > 1) {
    output = "combined";
    steps.push({
      id: output,
      kind: "combine",
      inputs: sources.map((_, index) => `source-${String(index + 1)}`),
      method: params.combine ?? "rrf",
    });
  }
  if (params.roles !== undefined) {
    const input = output;
    output = "role-filtered";
    steps.push({
      id: output,
      kind: "filter",
      input,
      roles: [...params.roles],
    });
  }
  if (params.order !== undefined && params.order !== "relevance") {
    const input = output;
    output = "ordered";
    steps.push({
      id: output,
      kind: "sort",
      input,
      order: params.order,
    });
  }
  if (params.maxPerSession !== undefined) {
    const input = output;
    output = "session-diverse";
    steps.push({
      id: output,
      kind: "diversify",
      input,
      by: "session",
      maxPerGroup: params.maxPerSession,
    });
  }
  return {
    id: "inline-search",
    version: "1",
    guide: {
      summary: "Inline search plan supplied with this search call.",
      useWhen: ["The current search call includes retrieval modifiers or branches."],
      cost: sources.length > 2 ? "high" : "medium",
    },
    steps,
    output,
  };
}

function assertHitsStayInScope(
  operator: string,
  scopeId: string,
  hits: readonly RetrievalHit[],
): void {
  for (const hit of hits) {
    if (hit.record.scopeId !== scopeId) {
      throw new Error(
        `Search operator ${operator} returned memory outside scope ${scopeId}`,
      );
    }
  }
}

export function createSearchMemory(options: SearchMemoryOptions): (
  params: SearchMemoryParams,
  signal?: AbortSignal,
) => Promise<SearchMemoryResult> {
  const seenQueryFingerprints = new Set<string>();
  return async (params, signal) => {
    const operator = params.operator ?? options.operatorRegistry.defaultOperatorId;
    const queries = normalizeStrings(params.queries, "queries");
    const order = params.order ?? options.searchDefaults?.order;
    params = { ...params, queries, ...(order === undefined ? {} : { order }) };
    const context = {
      scopeId: options.scopeId,
      ...(options.question === undefined
        ? {}
        : { question: options.question }),
      ...(options.questionDate === undefined
        ? {}
        : { questionDate: options.questionDate }),
      ...(signal === undefined ? {} : { signal }),
    };
    const visibleLimit = params.limit ?? options.searchDefaults?.limit ?? 20;
    if (!Number.isSafeInteger(visibleLimit) || visibleLimit < 1 || visibleLimit > 100) {
      throw new Error("Search limit must be an integer between 1 and 100");
    }
    const reservoirLimit = options.candidateReservoirLimit === undefined
      ? visibleLimit
      : Math.min(
          100,
          Math.max(visibleLimit, options.candidateReservoirLimit),
        );
    const input: SearchOperatorInput = {
      queries,
      limit: reservoirLimit,
      ...(params.roles === undefined ? {} : { roles: [...params.roles] }),
      ...(params.maxPerSession === undefined &&
          options.searchDefaults?.maxPerSession === undefined
        ? {}
        : {
            maxPerSession:
              params.maxPerSession ?? options.searchDefaults!.maxPerSession,
          }),
    };
    const definition = inlineSearchDefinition(params, operator);
    const executed = definition === undefined
      ? await executeSearchOperator(
          options.operatorRegistry,
          operator,
          context,
          input,
        )
      : await (async () => {
          const built = buildDeclarativeSearchOperator(
            options.operatorRegistry,
            definition,
            0,
          );
          const output = await built.operator.execute(context, input);
          assertHitsStayInScope(built.operator.id, options.scopeId, output.hits);
          return {
            ...output,
            request: params.order === undefined
              ? output.request
              : { ...output.request, order: params.order },
            operator: built.operator.id,
            operatorVersion: built.operator.version,
          };
        })();
    const executedQueries = normalizeStrings(
      executed.composition === undefined
        ? executed.request.queries
        : executed.composition.steps.flatMap((step) =>
            step.kind === "search" ? step.queries ?? [] : []
          ),
      "executed queries",
    );
    const currentFingerprints = new Set<string>();
    const repeatedQueries = executedQueries.filter((query) => {
      const fingerprint = searchQueryFingerprint(query);
      const repeated = seenQueryFingerprints.has(fingerprint) ||
        currentFingerprints.has(fingerprint);
      currentFingerprints.add(fingerprint);
      return repeated;
    });
    currentFingerprints.forEach((fingerprint) =>
      seenQueryFingerprints.add(fingerprint)
    );
    const parentHits = executed.hits.map((hit) =>
      hit.retriever === "fts5" || hit.retriever === "picorer-hybrid"
        ? {
            ...hit,
            preview: queryCenteredEpisodicPreview(
              hit.record.content,
              (hit.matchedQueries ?? [hit.query]).join(" "),
            ),
          }
        : hit
    );
    const reservoirHits = options.passageProjection === true
      ? projectSearchHitsToPassages(
          parentHits,
          reservoirLimit,
          operatorSourceQuotes(executed.operatorResult),
          executed.request.maxPerSession,
        )
      : parentHits.slice(0, reservoirLimit);
    const hits = reservoirHits.slice(0, visibleLimit);
    return {
      request: { ...executed.request, limit: visibleLimit },
      executedQueries,
      operator: executed.operator,
      operatorVersion: executed.operatorVersion,
      hits,
      repeatedQueries,
      ...(options.candidateReservoirLimit === undefined
        ? {}
        : {
            reservoir: {
              hits: reservoirHits,
              limit: reservoirLimit,
              exhausted: reservoirHits.length < reservoirLimit,
            },
          }),
      ...(executed.operatorResult === undefined
        ? {}
        : { operatorResult: executed.operatorResult }),
      ...(executed.composition === undefined
        ? {}
        : { composition: executed.composition }),
    };
  };
}
