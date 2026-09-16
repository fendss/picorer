import type { PicorerResult } from "../../evidence-agent/index.js";
import type { BenchmarkAnswerPrompt } from "../model/answer.js";
import type { AmaBenchPrivateQuery } from "./dataset-adapter.js";

export const AMA_BENCH_ANSWER_PROMPT_VERSION =
  "ama-bench-v4-openend-read-trajectory-v3";

export const AMA_BENCH_ANSWER_PROMPT_TEMPLATE = `You are answering a question about an agent-environment trajectory.

<instructions>
1. Use only the selected trajectory evidence below.
2. Treat each action and its following observation as one state transition.
3. Preserve exact step numbers, action names, object names, code symbols, values, and state changes.
4. Reconstruct causal order before answering causal, update, or abstraction questions.
5. If the selected evidence is insufficient, say that the evidence is insufficient; do not invent missing events.
6. Give a direct and concise answer with no preamble.
</instructions>

<trajectory_evidence>
{{evidence}}
</trajectory_evidence>

Question: {{question}}
Answer:`;

export interface AmaBenchAnswerContext {
  query: AmaBenchPrivateQuery;
  retrieval: PicorerResult;
}

function renderEvidence(
  memory: PicorerResult["evidence"][number],
): string {
  return `[memoryId=${memory.memoryId}]\n${memory.content}`;
}

/**
 * Converts Picorer output to the benchmark-owned answer prompt. Every exact
 * source returned by read is admitted; search-only candidates are excluded.
 */
export function buildAmaBenchAnswerPrompt(
  context: AmaBenchAnswerContext,
): BenchmarkAnswerPrompt {
  if (context.query.scopeId !== context.retrieval.scopeId) {
    throw new Error("AMA-Bench answer context has mismatched scope IDs");
  }
  if (context.query.question !== context.retrieval.question) {
    throw new Error("AMA-Bench answer context has mismatched question text");
  }

  const evidenceIds = new Set(
    context.retrieval.evidence.map((memory) => memory.memoryId),
  );
  const citationIds = new Set(
    context.retrieval.citations.map((citation) => citation.memoryId),
  );
  if (
    evidenceIds.size !== context.retrieval.evidence.length ||
    citationIds.size !== context.retrieval.citations.length ||
    evidenceIds.size !== citationIds.size ||
    [...evidenceIds].some((memoryId) => !citationIds.has(memoryId))
  ) {
    throw new Error("AMA-Bench exact read package and citations do not match");
  }
  const selected = [...context.retrieval.evidence];
  const evidence = selected
    .sort((left, right) => {
      const sessionOrder = left.sessionId.localeCompare(right.sessionId);
      return sessionOrder !== 0
        ? sessionOrder
        : left.turnIndex - right.turnIndex;
    })
    .map(renderEvidence)
    .join("\n\n");

  return {
    adapterId: "ama-bench-v4-openend",
    promptVersion: AMA_BENCH_ANSWER_PROMPT_VERSION,
    systemPrompt: "",
    userPrompt: AMA_BENCH_ANSWER_PROMPT_TEMPLATE
      .replace("{{evidence}}", evidence || "(none selected)")
      .replace("{{question}}", context.query.question),
  };
}
