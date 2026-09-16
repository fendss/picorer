import type {
  CreatePicorerToolsOptions,
  PicorerTools,
} from "./contracts.js";
import { DefineOperatorParameters } from "./schemas.js";

export function createDefineOperatorTool(
  options: CreatePicorerToolsOptions & {
    operatorDefinitions: NonNullable<CreatePicorerToolsOptions["operatorDefinitions"]>;
  },
): NonNullable<PicorerTools["defineOperator"]> {
  const initialSourceIds = options.operatorRegistry.list().map((entry) =>
    entry.id
  );
  const allowedSources = new Set(initialSourceIds);
  return {
    name: "define_operator",
    label: "Compose retrieval plan",
    description: [
      "Compose one ordered run-local retrieval plan from primitive retrievers and typed transformations.",
      "Search steps generate CandidateSets. Later steps may combine, filter, sort, diversify by session, dedupe content, limit, or annotate them. " +
      "Every input must reference an earlier step. The harness uses the last step as output and fills the fixed session/content modes. " +
      "This tool cannot read memory or create evidence.",
      `Primitive retrievers: ${initialSourceIds.join(", ")}.`,
      `Remaining definition budget at run start: ${options.operatorDefinitions.remainingDefinitions()}.`,
    ].join(" "),
    parameters: DefineOperatorParameters,
    async execute(_toolCallId, params) {
      if (
        Object.hasOwn(params, "roles") ||
        params.steps.some((step) =>
          String(step.kind) === "filter" || Object.hasOwn(step, "roles")
        )
      ) {
        throw new Error(
          "Source-role filtering is harness-owned and unavailable in " +
          "Agent-defined operators.",
        );
      }
      const steps = structuredClone(params.steps).map((step) =>
        step.kind === "diversify"
          ? { ...step, by: "session" as const }
          : step.kind === "dedupe"
            ? { ...step, by: "content" as const }
            : step
      );
      const sourceIds = steps
        .filter((step) => step.kind === "search")
        .map((step) => step.operator);
      const unknownSources = sourceIds.filter((source) =>
        !allowedSources.has(source)
      );
      if (unknownSources.length > 0) {
        throw new Error(
          "Operator sources must come from the initial catalog; unknown: " +
          unknownSources.join(", "),
        );
      }
      const definition = options.operatorDefinitions.define({
        id: params.id,
        version: "run-1",
        guide: {
          summary: params.summary,
          useWhen: [params.summary],
          cost: sourceIds.length > 2 ? "high" : "medium",
        },
        steps,
        output: steps.at(-1)!.id,
      });
      const snapshot = options.operatorDefinitions.snapshots().find(
        (item) => item.revision === definition.catalog.revision,
      );
      if (snapshot === undefined) {
        throw new Error("Defined operator snapshot is unavailable");
      }
      const details = {
        kind: "define_operator",
        definition,
        snapshot,
      } as const;
      return {
        content: [{
          type: "text" as const,
          text:
            `Composed ${definition.id}@${definition.version} for this run ` +
            `(catalog revision ${definition.catalog.revision}). ` +
            `Use search with operator=${JSON.stringify(definition.id)}.`,
        }],
        details,
      };
    },
  };
}
