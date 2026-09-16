import type { SearchOperatorDefinition, SearchOperatorDefinitionStep } from "../model/operator.js";
import type { SearchOperatorCatalog } from "../ports/operator-catalog.js";
import { sha256 } from "../../util.js";

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const MAX_STEPS = 12;
const MAX_SEARCH_STEPS = 4;
const MAX_COMBINE_INPUTS = 4;
const MEMORY_ROLES = new Set(["user", "assistant", "system", "other"]);

interface NormalizedDefinition {
  definition: SearchOperatorDefinition;
  definitionHash: string;
}

function normalizedText(value: string, label: string, maxLength = 240): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must contain at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizedIdentifier(value: string, label: string): string {
  const normalized = normalizedText(value, label);
  if (!IDENTIFIER.test(normalized)) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(normalized)}; expected ${String(IDENTIFIER)}`,
    );
  }
  return normalized;
}

function normalizedLimit(
  value: number | undefined,
  label: string,
  required = false,
): number | undefined {
  if (value === undefined && !required) return undefined;
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${label} must be an integer between 1 and 100`);
  }
  return value;
}

export function normalizeDefinition(
  catalog: SearchOperatorCatalog,
  source: SearchOperatorDefinition,
): NormalizedDefinition {
  const id = normalizedIdentifier(source.id, "operator ID");
  const version = normalizedText(source.version, `operator ${id} version`, 64);
  const summary = normalizedText(source.guide.summary, `operator ${id} summary`);
  if (!(["low", "medium", "high"] as const).includes(source.guide.cost)) {
    throw new Error(`Operator ${id} has an unsupported cost`);
  }
  const useWhen = source.guide.useWhen.map((value, index) =>
    normalizedText(value, `operator ${id} useWhen[${index}]`)
  );
  if (useWhen.length === 0 || useWhen.length > 3) {
    throw new Error(`Operator ${id} must declare between 1 and 3 useWhen rules`);
  }
  const avoidWhen = source.guide.avoidWhen?.map((value, index) =>
    normalizedText(value, `operator ${id} avoidWhen[${index}]`)
  );
  if (avoidWhen !== undefined && avoidWhen.length > 3) {
    throw new Error(`Operator ${id} may declare at most 3 avoidWhen rules`);
  }
  if (source.steps.length < 1 || source.steps.length > MAX_STEPS) {
    throw new Error(`Operator ${id} must contain between 1 and ${MAX_STEPS} steps`);
  }

  const seen = new Set<string>();
  let searchSteps = 0;
  const steps: SearchOperatorDefinitionStep[] = source.steps.map(
    (sourceStep, index) => {
    const stepId = normalizedIdentifier(sourceStep.id, `step ${index + 1} ID`);
    if (seen.has(stepId)) {
      throw new Error(`Operator ${id} contains duplicate step ID ${stepId}`);
    }
    const priorInput = (value: string, label = "input"): string => {
      const normalized = normalizedIdentifier(value, `step ${stepId} ${label}`);
      if (!seen.has(normalized)) {
        throw new Error(
          `Operator ${id} step ${stepId} references unavailable prior step ${normalized}`,
        );
      }
      return normalized;
    };
    let step: SearchOperatorDefinitionStep;
    if (sourceStep.kind === "search") {
      searchSteps += 1;
      if (searchSteps > MAX_SEARCH_STEPS) {
        throw new Error(
          `Operator ${id} may contain at most ${MAX_SEARCH_STEPS} search steps`,
        );
      }
      const operator = normalizedIdentifier(
        sourceStep.operator,
        `step ${stepId} operator`,
      );
      if (operator === id) {
        throw new Error(`Operator ${id} cannot call itself`);
      }
      catalog.get(operator);
      const limit = normalizedLimit(sourceStep.limit, `step ${stepId} limit`);
      const queries = sourceStep.queries?.map((query, queryIndex) =>
        normalizedText(query, `step ${stepId} queries[${queryIndex}]`, 512)
      );
      if (queries !== undefined && (queries.length < 1 || queries.length > 16)) {
        throw new Error(
          `Operator ${id} search step ${stepId} must contain between 1 and 16 queries`,
        );
      }
      step = {
        id: stepId,
        kind: "search",
        operator,
        ...(queries === undefined ? {} : { queries: [...new Set(queries)] }),
        ...(limit === undefined ? {} : { limit }),
      };
    } else if (sourceStep.kind === "combine") {
      if (
        sourceStep.inputs.length < 2 ||
        sourceStep.inputs.length > MAX_COMBINE_INPUTS
      ) {
        throw new Error(
          `Operator ${id} combine step ${stepId} must have between 2 and ${MAX_COMBINE_INPUTS} inputs`,
        );
      }
      const inputs = sourceStep.inputs.map((input, inputIndex) =>
        priorInput(input, `input[${inputIndex}]`)
      );
      if (new Set(inputs).size !== inputs.length) {
        throw new Error(
          `Operator ${id} combine step ${stepId} inputs must be distinct`,
        );
      }
      const method = sourceStep.method;
      if (
        method !== "union" && method !== "rrf" && method !== "intersection"
      ) {
        throw new Error(
          `Operator ${id} step ${stepId} has an unsupported combine method`,
        );
      }
      const limit = normalizedLimit(sourceStep.limit, `step ${stepId} limit`);
      step = {
        id: stepId,
        kind: "combine",
        inputs,
        method,
        ...(limit === undefined ? {} : { limit }),
      };
    } else if (sourceStep.kind === "filter") {
      const input = priorInput(sourceStep.input);
      const roles = [...new Set(sourceStep.roles)];
      if (
        roles.length === 0 ||
        roles.some((role) => !MEMORY_ROLES.has(role))
      ) {
        throw new Error(
          `Operator ${id} filter step ${stepId} must contain valid memory roles`,
        );
      }
      step = { id: stepId, kind: "filter", input, roles };
    } else if (sourceStep.kind === "sort") {
      const input = priorInput(sourceStep.input);
      if (
        sourceStep.order !== "relevance" &&
        sourceStep.order !== "chronological" &&
        sourceStep.order !== "reverse-chronological"
      ) {
        throw new Error(`Operator ${id} sort step ${stepId} has an invalid order`);
      }
      step = { id: stepId, kind: "sort", input, order: sourceStep.order };
    } else if (sourceStep.kind === "diversify") {
      const input = priorInput(sourceStep.input);
      if (sourceStep.by !== "session") {
        throw new Error(
          `Operator ${id} diversify step ${stepId} only supports session groups`,
        );
      }
      const maxPerGroup = normalizedLimit(
        sourceStep.maxPerGroup,
        `step ${stepId} maxPerGroup`,
        true,
      )!;
      step = {
        id: stepId,
        kind: "diversify",
        input,
        by: "session",
        maxPerGroup,
      };
    } else if (sourceStep.kind === "dedupe") {
      const input = priorInput(sourceStep.input);
      if (sourceStep.by !== "content") {
        throw new Error(
          `Operator ${id} dedupe step ${stepId} only supports content`,
        );
      }
      step = { id: stepId, kind: "dedupe", input, by: "content" };
    } else if (sourceStep.kind === "limit") {
      const input = priorInput(sourceStep.input);
      step = {
        id: stepId,
        kind: "limit",
        input,
        limit: normalizedLimit(sourceStep.limit, `step ${stepId} limit`, true)!,
      };
    } else if (sourceStep.kind === "annotate") {
      const input = priorInput(sourceStep.input);
      if (sourceStep.method !== "temporal" && sourceStep.method !== "numeric") {
        throw new Error(
          `Operator ${id} annotate step ${stepId} has an invalid method`,
        );
      }
      step = {
        id: stepId,
        kind: "annotate",
        input,
        method: sourceStep.method,
      };
    } else {
      throw new Error(`Operator ${id} step ${stepId} has an unsupported kind`);
    }
    seen.add(stepId);
    return step;
  });

  const output = normalizedIdentifier(source.output, `operator ${id} output`);
  if (!seen.has(output)) {
    throw new Error(`Operator ${id} output references unknown step ${output}`);
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const reachable = new Set<string>();
  const visit = (stepId: string): void => {
    if (reachable.has(stepId)) return;
    reachable.add(stepId);
    const step = byId.get(stepId)!;
    if (step.kind === "combine") step.inputs.forEach(visit);
    else if (step.kind !== "search") visit(step.input);
  };
  visit(output);
  if (reachable.size !== steps.length) {
    const unused = steps
      .map((step) => step.id)
      .filter((stepId) => !reachable.has(stepId));
    throw new Error(`Operator ${id} contains unused steps: ${unused.join(", ")}`);
  }
  const definition: SearchOperatorDefinition = {
    id,
    version,
    guide: {
      summary,
      useWhen,
      ...(avoidWhen === undefined ? {} : { avoidWhen }),
      cost: source.guide.cost,
    },
    steps,
    output,
  };
  return {
    definition,
    definitionHash: sha256(JSON.stringify(definition)),
  };
}
