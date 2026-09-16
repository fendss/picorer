import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildMemoryAgentBenchAnswerPrompt } from "../src/benchmark/memoryagentbench/answer-contract.js";
import {
  readMemoryAgentBenchQuestions,
  readMemoryAgentBenchSessions,
} from "../src/benchmark/memoryagentbench/dataset.js";
import type { PicorerResult } from "../src/evidence-agent/index.js";

describe("MemoryAgentBench public adapter", () => {
  it("loads public contexts/questions without requiring gold", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-mab-"));
    await mkdir(join(root, "public", "questions"), { recursive: true });
    await mkdir(join(root, "public", "contexts", "trec-fine"), { recursive: true });
    await writeFile(join(root, "public", "questions", "trec-fine.jsonl"), `${JSON.stringify({
      questionId: "trec-fine/c000/q000",
      scopeId: "mab/trec-fine/c000",
      contextId: "trec-fine/c000",
      sequence: 0,
      question: "What is this?",
      task: "in_context_learning",
      track: "ttl-extension",
      upstreamQaId: "icl_trec_fine_6400shot_balance_no0",
    })}\n`);
    await writeFile(join(root, "public", "contexts", "trec-fine", "c000.jsonl"), `${JSON.stringify({
      scopeId: "mab/trec-fine/c000",
      sessionId: "chunk-0000",
      turns: [{ role: "other", content: "Example. label: 1" }],
    })}\n`);

    const questions = await readMemoryAgentBenchQuestions(root, "trec-fine");
    const sessions = await readMemoryAgentBenchSessions(root, "trec-fine", questions[0]!.contextId);
    expect(questions).toHaveLength(1);
    expect(sessions[0]?.turns[0]?.content).toBe("Example. label: 1");
  });

  it("admits every exact read source to the official-style answer prompt", () => {
    const question = {
      questionId: "trec-fine/c000/q000",
      scopeId: "mab/trec-fine/c000",
      contextId: "trec-fine/c000",
      sequence: 0,
      question: "What is this?",
      task: "in_context_learning" as const,
      track: "ttl-extension" as const,
      upstreamQaId: "icl_trec_fine_6400shot_balance_no0",
    };
    const retrieval = {
      scopeId: question.scopeId,
      question: question.question,
      status: "sufficient",
      citations: [
        { memoryId: "m1", supports: "direct example" },
        { memoryId: "m2", supports: "neighboring example" },
      ],
      evidenceSummary: "The first exact passage contains the matching label.",
      evidence: [
        {
          memoryId: "m1",
          sessionId: "chunk-0001",
          turnIndex: 0,
          role: "other",
          timestamp: "2025-01-02T03:04:00",
          content: "keep label: 7",
        },
        {
          memoryId: "m2",
          sessionId: "chunk-0002",
          turnIndex: 0,
          role: "other",
          content: "second read label: 9",
        },
      ],
    } as PicorerResult;
    const prompt = buildMemoryAgentBenchAnswerPrompt(question, retrieval);
    expect(prompt.systemPrompt).toBe(
      "You are a helpful assistant that answers only from the selected memorized context.",
    );
    expect(prompt.userPrompt).not.toContain("status=");
    expect(prompt.userPrompt).not.toContain("<retrieval_summary");
    expect(prompt.userPrompt).not.toContain(
      "The first exact passage contains the matching label.",
    );
    expect(prompt.userPrompt).toContain("role: other");
    expect(prompt.userPrompt).toContain("timestamp: 2025-01-02T03:04:00");
    expect(prompt.userPrompt).toContain("keep label: 7");
    expect(prompt.userPrompt).toContain("second read label: 9");
    expect(prompt.userPrompt).toContain('Only output "label: {label}"');
    expect(prompt.userPrompt).toBe([
      '<retrieval_package selected_sources="2">',
      "</retrieval_package>",
      "<selected_memories>",
      "<memory>",
      "memory_id: m1",
      "session_id: chunk-0001",
      "turn_index: 0",
      "role: other",
      "timestamp: 2025-01-02T03:04:00",
      "content:",
      "keep label: 7",
      "</memory>",
      "",
      "<memory>",
      "memory_id: m2",
      "session_id: chunk-0002",
      "turn_index: 0",
      "role: other",
      "timestamp: unknown",
      "content:",
      "second read label: 9",
      "</memory>",
      "</selected_memories>",
      "",
      'Use the provided mapping from the context to numerical label to assign a numerical label to the context. Only output "label: {label}" and nothing else.',
      "",
      "What is this?",
      "",
      "label:",
    ].join("\n"));
    expect(prompt.promptVersion).toBe(
      "memoryagentbench-read-evidence-no-summary-no-status-20260831-v7",
    );

    const insufficientPrompt = buildMemoryAgentBenchAnswerPrompt(question, {
      ...retrieval,
      status: "insufficient",
    });
    expect(insufficientPrompt).toEqual(prompt);
  });
});
