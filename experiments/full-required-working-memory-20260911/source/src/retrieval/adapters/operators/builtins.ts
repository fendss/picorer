import { finalizeSearchHits } from "../../finalize-search-hits.js";
import {
  resolveTemporalQuestion,
  temporalAuxiliaryRequest,
} from "../../operators/temporal-operator.js";
import type {
  EvidenceOperatorSearchContext,
  RetrievalHit,
  SearchOrder,
  SearchRequest,
} from "../../model/search.js";
import type { SearchOperatorInput } from "../../model/operator.js";
import type { SearchOperatorStore } from "../../ports/memory-tool-store.js";
import type { SearchOperator } from "../../ports/search-operator.js";
import { mergeHitProvenance } from "../../model/hit-provenance.js";

const VERSION = "4";

function makeSearchRequest(
  input: SearchOperatorInput,
  order: SearchOrder = "relevance",
): SearchRequest {
  return {
    queries: [...input.queries],
    limit: input.limit,
    order,
    ...(input.roles === undefined ? {} : { roles: [...input.roles] }),
    ...(input.maxPerSession === undefined
      ? {}
      : { maxPerSession: input.maxPerSession }),
  };
}

function mergeHits(
  preferred: readonly RetrievalHit[],
  fallback: readonly RetrievalHit[],
  limit: number,
): RetrievalHit[] {
  const merged = new Map<string, RetrievalHit>();
  for (const hit of [...preferred, ...fallback]) {
    const previous = merged.get(hit.record.memoryId);
    if (previous !== undefined) merged.set(hit.record.memoryId, mergeHitProvenance(previous, hit));
    else if (merged.size < limit) merged.set(hit.record.memoryId, hit);
  }
  return [...merged.values()].map((hit, index) => ({
    ...hit,
    rank: index + 1,
  }));
}

function hybridOperator(store: SearchOperatorStore): SearchOperator {
  return {
    id: "hybrid",
    version: VERSION,
    guide: {
      summary: "Primitive relevance retriever combining the configured semantic and lexical index.",
      useWhen: ["Source wording may differ from the question."],
      avoidWhen: ["Only an exact rare string is useful."],
      cost: "medium",
    },
    async execute(context, input) {
      const request = makeSearchRequest(input);
      return {
        request,
        hits: await store.search(context.scopeId, request, context.signal),
      };
    },
  };
}

function lexicalOperator(store: SearchOperatorStore): SearchOperator {
  return {
    id: "lexical",
    version: VERSION,
    guide: {
      summary: "Primitive exact-text retriever.",
      useWhen: ["A name, quotation, identifier, number, or distinctive phrase is known."],
      avoidWhen: ["The source is likely paraphrased."],
      cost: "low",
    },
    async execute(context, input) {
      const request = makeSearchRequest(input);
      return {
        request,
        hits: store.searchLexical === undefined
          ? await store.search(context.scopeId, request, context.signal)
          : await store.searchLexical(context.scopeId, request, context.signal),
      };
    },
  };
}

function chronologicalOperator(store: SearchOperatorStore): SearchOperator {
  return {
    id: "chronological",
    version: VERSION,
    guide: {
      summary: "Primitive query retriever ordered by source time.",
      useWhen: ["A plan will compare earlier, later, latest, or previous source records."],
      avoidWhen: ["Relevance rank alone should determine candidate order."],
      cost: "medium",
    },
    async execute(context, input) {
      const request = makeSearchRequest(input, "chronological");
      return {
        request,
        hits: await store.search(context.scopeId, request, context.signal),
      };
    },
  };
}

function evidenceIndexOperator(
  store: SearchOperatorStore,
  operator: "temporal" | "numeric",
): SearchOperator {
  const temporal = operator === "temporal";
  return {
    id: temporal ? "temporal-index" : "numeric-index",
    version: VERSION,
    guide: temporal
      ? {
          summary: "Primitive date-index retriever; compose with annotate(temporal) for a timeline.",
          useWhen: ["Date mentions, source timestamps, or a relative-date window should generate candidates."],
          avoidWhen: ["No temporal field is evidence-bearing."],
          cost: "medium",
        }
      : {
          summary: "Primitive numeric-fact index retriever; compose with annotate(numeric) for typed values.",
          useWhen: ["Amounts, counts, thresholds, totals, or changing numeric states should generate candidates."],
          avoidWhen: ["Numbers are incidental."],
          cost: "medium",
        },
    async execute(context, input) {
      const request = makeSearchRequest(input);
      const maxCandidates = temporal ? 60 : 80;
      const question = context.question ?? request.queries.join(" ");
      const temporalPlan = temporal
        ? resolveTemporalQuestion(question, context.questionDate)
        : undefined;
      const auxiliaryRequest = temporalPlan === undefined
        ? undefined
        : temporalAuxiliaryRequest(request, temporalPlan);
      const [primaryHits, auxiliaryHits] = await Promise.all([
        store.search(context.scopeId, request, context.signal),
        auxiliaryRequest === undefined
          ? Promise.resolve([])
          : store.search(context.scopeId, auxiliaryRequest, context.signal),
      ]);
      const seedHits = mergeHits(primaryHits, auxiliaryHits, maxCandidates);
      const expansionContext: EvidenceOperatorSearchContext = {
        operator,
        maxCandidates,
        ...(temporalPlan === undefined || temporalPlan.targets.length === 0
          ? {}
          : { targetDates: temporalPlan.targets.map((target) => target.date) }),
      };
      const indexedHits = store.expandEvidenceOperator === undefined
        ? []
        : await store.expandEvidenceOperator(
            context.scopeId,
            request,
            expansionContext,
            seedHits,
          );
      return {
        request,
        hits: finalizeSearchHits(
          mergeHits(indexedHits, seedHits, indexedHits.length + seedHits.length),
          request,
          Math.min(input.limit, maxCandidates),
        ),
      };
    },
  };
}

export function builtInSearchOperators(
  store: SearchOperatorStore,
): SearchOperator[] {
  return [
    hybridOperator(store),
    lexicalOperator(store),
    chronologicalOperator(store),
    evidenceIndexOperator(store, "temporal"),
    evidenceIndexOperator(store, "numeric"),
  ];
}
