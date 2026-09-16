import type { PicorerResult } from "../../evidence-agent/index.js";
import type { BenchmarkAnswerPrompt } from "../model/answer.js";
import type { MemoryAgentBenchQuestion, MemoryAgentBenchTask } from "./dataset.js";

export const MEMORY_AGENT_BENCH_ANSWER_PROMPT_VERSION =
  "memoryagentbench-read-evidence-no-summary-no-status-20260831-v7";

const TASK_PROMPTS: Record<MemoryAgentBenchTask, string> = {
  ruler_qa: `Answer the question based on the memorized documents. Only give me the answer and do not output any other words.

Question: {{question}}

Answer:`,
  eventqa: `Based on the context you memorized, complete the task below:

{{question}}

The event that happens next is:`,
  longmemeval: `The history chats are between you and a user. Based on the relevant chat history, answer the question as concisely as you can, using a single phrase if possible.

{{question}}

Answer:`,
  in_context_learning: `Use the provided mapping from the context to numerical label to assign a numerical label to the context. Only output "label: {label}" and nothing else.

{{question}}

label:`,
  factconsolidation: `Pretend you are a knowledge management system. Each fact in the knowledge pool is provided with a serial number at the beginning, and the newer fact has larger serial number.
You need to solve conflicts by finding the newest fact with the larger serial number. Give a very concise answer for the question only from the provided knowledge pool rather than real-world facts.

Now Answer the Question: Based on the provided Knowledge Pool, {{question}}
Answer:`,
};

function renderEvidence(memory: PicorerResult["evidence"][number]): string {
  return [
    "<memory>",
    `memory_id: ${memory.memoryId}`,
    `session_id: ${memory.sessionId}`,
    `turn_index: ${String(memory.turnIndex)}`,
    `role: ${memory.role}`,
    `timestamp: ${memory.timestamp ?? "unknown"}`,
    "content:",
    memory.content,
    "</memory>",
  ].join("\n");
}

/**
 * Keeps MemoryAgentBench's task instruction intact while replacing the
 * benchmark's hidden archival-memory implementation with Picorer's exact read
 * package. The retrieval Agent's free-text summary and sufficiency status are
 * deliberately excluded. Every read source and its harness-generated citation
 * must agree before exact sources become answer authority.
 */
export function buildMemoryAgentBenchAnswerPrompt(
  question: MemoryAgentBenchQuestion,
  retrieval: PicorerResult,
): BenchmarkAnswerPrompt {
  if (retrieval.scopeId !== question.scopeId || retrieval.question !== question.question) {
    throw new Error("MemoryAgentBench answer context does not match retrieval");
  }
  const evidenceIds = new Set(retrieval.evidence.map((memory) => memory.memoryId));
  const citationIds = new Set(retrieval.citations.map((citation) => citation.memoryId));
  if (
    evidenceIds.size !== retrieval.evidence.length ||
    citationIds.size !== retrieval.citations.length ||
    evidenceIds.size !== citationIds.size ||
    [...evidenceIds].some((memoryId) => !citationIds.has(memoryId))
  ) {
    throw new Error("MemoryAgentBench exact read package and citations do not match");
  }
  const selected = [...retrieval.evidence];
  const evidence = selected
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map(renderEvidence)
    .join("\n\n");
  const taskPrompt = TASK_PROMPTS[question.task].replace(
    "{{question}}",
    question.question,
  );
  return {
    adapterId: `memoryagentbench-${question.task}`,
    promptVersion: MEMORY_AGENT_BENCH_ANSWER_PROMPT_VERSION,
    systemPrompt: "You are a helpful assistant that answers only from the selected memorized context.",
    userPrompt: [
      `<retrieval_package selected_sources="${String(selected.length)}">`,
      "</retrieval_package>",
      `<selected_memories>\n${evidence || "(none selected)"}\n</selected_memories>`,
      "",
      taskPrompt,
    ].join("\n"),
  };
}
