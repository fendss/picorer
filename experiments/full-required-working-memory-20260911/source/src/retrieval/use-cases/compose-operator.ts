import type { EvidenceOperatorResult, SearchRequest } from "../model/search.js";
import type { CandidateSet, SearchOperatorCompositionStepTrace, SearchOperatorDefinition, SearchOperatorInput, SearchOperatorOutput } from "../model/operator.js";
import type { SearchOperator } from "../ports/search-operator.js";
import type { SearchOperatorCatalog } from "../ports/operator-catalog.js";
import { normalizeDefinition } from "./operator-definition.js";
import { discoveryPolicies, intersectRoles } from "./operator-discovery.js";
import { executeSearchOperator } from "./execute-operator.js";
import { withRanks, unionCandidateSets, rrfCandidateSets, intersectCandidateSets, sortCandidateSet, diversifyBySession, dedupeByContent, annotateCandidateSet, retainOperatorResult } from "./candidate-set.js";

function requestFor(input: SearchOperatorInput): SearchRequest {
  return {
    queries: [...input.queries],
    limit: input.limit,
    order: "relevance",
    ...(input.roles === undefined ? {} : { roles: [...input.roles] }),
    ...(input.maxPerSession === undefined
      ? {}
      : { maxPerSession: input.maxPerSession }),
  };
}

export interface BuiltDeclarativeSearchOperator {
  operator: SearchOperator;
  definition: SearchOperatorDefinition;
  definitionHash: string;
}

export function buildDeclarativeSearchOperator(
  catalog: SearchOperatorCatalog,
  source: SearchOperatorDefinition,
  definitionRevision: number,
): BuiltDeclarativeSearchOperator {
  const { definition, definitionHash } = normalizeDefinition(catalog, source);
  const policies = discoveryPolicies(definition.steps, definition.output);
  const operator: SearchOperator = {
    id: definition.id,
    version: definition.version,
    guide: definition.guide,
    async execute(context, input) {
      const candidateSets = new Map<string, CandidateSet & {
        operatorResult?: EvidenceOperatorResult;
      }>();
      const trace: SearchOperatorCompositionStepTrace[] = [];
      for (const step of definition.steps) {
        context.signal?.throwIfAborted();
        if (step.kind === "search") {
          let child: SearchOperatorOutput;
          const childOperator = catalog.get(step.operator);
          const discovery = policies.get(step.id);
          const maxPerSession = discovery?.maxPerSession === undefined
            ? input.maxPerSession
            : Math.min(
              input.maxPerSession ?? discovery.maxPerSession,
              discovery.maxPerSession,
            );
          const roles = intersectRoles(input.roles, discovery?.roles);
          try {
            child = await executeSearchOperator(catalog, step.operator, context, {
              ...input,
              ...(step.queries === undefined
                ? {}
                : { queries: [...step.queries] }),
              limit: step.limit ?? input.limit,
              ...(roles === undefined ? {} : { roles }),
              ...(maxPerSession === undefined ? {} : { maxPerSession }),
            });
          } catch (error) {
            throw new Error(
              `Operator ${definition.id} failed at search step ${step.id} (${step.operator})`,
              { cause: error },
            );
          }
          const hits = withRanks(child.hits, step.limit ?? input.limit);
          candidateSets.set(step.id, {
            hits,
            ...(child.operatorResult === undefined
              ? {}
              : { operatorResult: child.operatorResult }),
          });
          trace.push({
            id: step.id,
            kind: "search",
            operator: step.operator,
            operatorVersion: childOperator.version,
            queries: child.composition === undefined
              ? [...child.request.queries]
              : [...new Set(child.composition.steps.flatMap((item) => item.queries ?? []))],
            ...(roles === undefined ? {} : { roles: [...roles] }),
            ...(maxPerSession === undefined ? {} : { maxPerSession }),
            candidateCount: hits.length,
          });
          continue;
        }
        if (step.kind === "combine") {
          const inputs = step.inputs.map(
            (inputId) => candidateSets.get(inputId)!.hits,
          );
          const limit = step.limit ?? input.limit;
          const hits = step.method === "union"
            ? unionCandidateSets(inputs, limit)
            : step.method === "rrf"
              ? rrfCandidateSets(inputs, limit)
              : intersectCandidateSets(inputs, limit);
          candidateSets.set(step.id, { hits });
          trace.push({
            id: step.id,
            kind: "combine",
            inputs: [...step.inputs],
            method: step.method,
            candidateCount: hits.length,
          });
          continue;
        }
        const source = candidateSets.get(step.input)!;
        if (step.kind === "filter") {
          const roles = new Set(step.roles);
          const hits = withRanks(
            source.hits.filter((hit) => roles.has(hit.record.role)),
            source.hits.length,
          );
          candidateSets.set(step.id, { hits, ...retainOperatorResult(source.operatorResult, hits) });
          trace.push({
            id: step.id,
            kind: "filter",
            input: step.input,
            roles: [...step.roles],
            candidateCount: hits.length,
          });
          continue;
        }
        if (step.kind === "sort") {
          const hits = sortCandidateSet(source.hits, step.order);
          candidateSets.set(step.id, { hits, ...retainOperatorResult(source.operatorResult, hits) });
          trace.push({
            id: step.id,
            kind: "sort",
            input: step.input,
            order: step.order,
            candidateCount: hits.length,
          });
          continue;
        }
        if (step.kind === "diversify") {
          const hits = diversifyBySession(source.hits, step.maxPerGroup);
          candidateSets.set(step.id, { hits, ...retainOperatorResult(source.operatorResult, hits) });
          trace.push({
            id: step.id,
            kind: "diversify",
            input: step.input,
            by: step.by,
            maxPerGroup: step.maxPerGroup,
            candidateCount: hits.length,
          });
          continue;
        }
        if (step.kind === "dedupe") {
          const hits = dedupeByContent(source.hits);
          candidateSets.set(step.id, { hits, ...retainOperatorResult(source.operatorResult, hits) });
          trace.push({
            id: step.id,
            kind: "dedupe",
            input: step.input,
            by: step.by,
            candidateCount: hits.length,
          });
          continue;
        }
        if (step.kind === "limit") {
          const hits = withRanks(source.hits, step.limit);
          candidateSets.set(step.id, { hits, ...retainOperatorResult(source.operatorResult, hits) });
          trace.push({
            id: step.id,
            kind: "limit",
            input: step.input,
            limit: step.limit,
            candidateCount: hits.length,
          });
          continue;
        }
        const operatorResult = annotateCandidateSet(
          step.method,
          source.hits,
          context.question ?? input.queries.join(" "),
          context.questionDate,
        );
        candidateSets.set(step.id, { hits: source.hits, operatorResult });
        trace.push({
          id: step.id,
          kind: "annotate",
          input: step.input,
          annotation: step.method,
          candidateCount: source.hits.length,
        });
      }
      const output = candidateSets.get(definition.output)!;
      const hits = withRanks(output.hits, input.limit);
      return {
        request: requestFor(input),
        hits,
        ...retainOperatorResult(output.operatorResult, hits),
        composition: {
          definitionHash,
          definitionRevision,
          steps: trace,
        },
      };
    },
  };
  return { operator, definition, definitionHash };
}
