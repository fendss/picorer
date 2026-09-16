import { runBenchmarkAnswer } from "../adapters/pi/answer.js";
import type { BenchmarkAnswerResult } from "../model/answer.js";
import type { PiModelRuntime } from "../../platform/pi/load-model-runtime.js";
import type {
  AmaBenchCapability,
  AmaBenchDomain,
  AmaBenchTaskType,
} from "./dataset-adapter.js";
import type { AmaBenchEvaluatorInput } from "./evaluation-contract.js";

export const AMA_BENCH_JUDGE_PROMPT_VERSION =
  "ama-bench-v4-official-binary-judge-v1";

export type AmaBenchJudgeDecision = "yes" | "no" | "unparseable";

export type AmaBenchJudgeFallback =
  | { used: false }
  | {
      used: true;
      reason: "unparseable-yes-no";
      metric: "token-f1";
      score: number;
    };

export interface AmaBenchParsedJudgeAnswer {
  cleanedAnswer: string;
  decision: AmaBenchJudgeDecision;
  score: number;
  fallback: AmaBenchJudgeFallback;
}

export interface AmaBenchJudgeResult {
  episodeId: number;
  questionId: string;
  domain: AmaBenchDomain;
  taskType: AmaBenchTaskType;
  capability: AmaBenchCapability;
  score: number;
  decision: AmaBenchJudgeDecision;
  judgeAnswer: string;
  cleanedJudgeAnswer: string;
  fallback: AmaBenchJudgeFallback;
  model: BenchmarkAnswerResult["model"];
  usage: BenchmarkAnswerResult["usage"];
  prompt: {
    adapter: string;
    version: string;
    hash: string;
  };
}

export interface AmaBenchJudgeBucket {
  count: number;
  avgScore: number;
  accuracy: number;
}

export interface AmaBenchJudgeAggregate {
  overall: AmaBenchJudgeBucket;
  byDomain: Partial<Record<AmaBenchDomain, AmaBenchJudgeBucket>>;
  byTaskType: Partial<Record<AmaBenchTaskType, AmaBenchJudgeBucket>>;
  byCapability: Partial<Record<AmaBenchCapability, AmaBenchJudgeBucket>>;
}

/** Exact prompt shape used by the pinned upstream v4 Python evaluator. */
export function buildAmaBenchJudgePrompt(
  input: AmaBenchEvaluatorInput,
): string {
  const context = [
    `Task Type: ${input.task_type}`,
    `Episode ID: ${input.episode_id}`,
    `Task Context: ${input.task_description}`,
  ].join("\n");
  return `You are an expert evaluator. You will be given a question, a reference answer, and a predicted answer.
Your task is to determine if the predicted answer is correct based on:
1. Factual correctness compared to the reference
2. Completeness of the answer
3. Relevance to the question

${context}

Question: ${input.question}

Reference Answer: ${input.golden_answer}

Predicted Answer: ${input.predicted_answer}

Is the predicted answer correct? Respond with ONLY "yes" or "no". Do not include any thinking process, explanation, or additional text.

Answer:<think></think>`;
}

/** Python-compatible normalization from the official fallback evaluator. */
export function normalizeAmaBenchJudgeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !["a", "an", "the"].includes(token))
    .join(" ");
}

function tokenCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Multiset token F1 used when upstream cannot parse a binary judge answer. */
export function amaBenchTokenF1(predicted: string, golden: string): number {
  const predictedTokens = normalizeAmaBenchJudgeText(predicted)
    .split(" ")
    .filter(Boolean);
  const goldenTokens = normalizeAmaBenchJudgeText(golden)
    .split(" ")
    .filter(Boolean);
  if (predictedTokens.length === 0 && goldenTokens.length === 0) return 1;
  if (predictedTokens.length === 0 || goldenTokens.length === 0) return 0;

  const predictedCounts = tokenCounts(predictedTokens);
  const goldenCounts = tokenCounts(goldenTokens);
  let common = 0;
  for (const [token, count] of predictedCounts) {
    common += Math.min(count, goldenCounts.get(token) ?? 0);
  }
  if (common === 0) return 0;
  const precision = common / predictedTokens.length;
  const recall = common / goldenTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Removes closed think blocks, then follows upstream's "last complete word"
 * rule. An unparseable answer is explicit and falls back to prediction-vs-gold
 * token F1; the judge prose itself is never used for fallback scoring.
 */
export function parseAmaBenchJudgeAnswer(
  judgeAnswer: string,
  predictedAnswer: string,
  goldenAnswer: string,
): AmaBenchParsedJudgeAnswer {
  const cleanedAnswer = judgeAnswer
    .replace(/<think>.*?<\/think>/gisu, "")
    .trim();
  let lastDecision: "yes" | "no" | undefined;
  for (const match of cleanedAnswer.matchAll(
    /(?<![\p{L}\p{N}_])(?:yes|no)(?![\p{L}\p{N}_])/giu,
  )) {
    lastDecision = match[0]!.toLowerCase() as "yes" | "no";
  }
  if (lastDecision !== undefined) {
    return {
      cleanedAnswer,
      decision: lastDecision,
      score: lastDecision === "yes" ? 1 : 0,
      fallback: { used: false },
    };
  }
  const score = amaBenchTokenF1(predictedAnswer, goldenAnswer);
  return {
    cleanedAnswer,
    decision: "unparseable",
    score,
    fallback: {
      used: true,
      reason: "unparseable-yes-no",
      metric: "token-f1",
      score,
    },
  };
}

export async function judgeAmaBenchQuestion(options: {
  input: AmaBenchEvaluatorInput;
  modelRuntime: PiModelRuntime;
  maxRunMs?: number;
}): Promise<AmaBenchJudgeResult> {
  const answer = await runBenchmarkAnswer({
    modelRuntime: options.modelRuntime,
    prompt: {
      adapterId: "ama-bench-v4-official-judge",
      promptVersion: AMA_BENCH_JUDGE_PROMPT_VERSION,
      systemPrompt: "",
      userPrompt: buildAmaBenchJudgePrompt(options.input),
    },
    ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
  });
  const parsed = parseAmaBenchJudgeAnswer(
    answer.answer,
    options.input.predicted_answer,
    options.input.golden_answer,
  );
  return {
    episodeId: options.input.episode_id,
    questionId: options.input.question_uuid,
    domain: options.input.domain,
    taskType: options.input.task_type,
    capability: options.input.qa_type,
    score: parsed.score,
    decision: parsed.decision,
    judgeAnswer: answer.answer,
    cleanedJudgeAnswer: parsed.cleanedAnswer,
    fallback: parsed.fallback,
    model: answer.model,
    usage: answer.usage,
    prompt: {
      adapter: answer.promptAdapter,
      version: answer.promptVersion,
      hash: answer.promptHash,
    },
  };
}

function bucket(results: readonly AmaBenchJudgeResult[]): AmaBenchJudgeBucket {
  if (results.length === 0) return { count: 0, avgScore: 0, accuracy: 0 };
  const total = results.reduce((sum, result) => sum + result.score, 0);
  return {
    count: results.length,
    avgScore: total / results.length,
    accuracy:
      results.filter((result) => result.score === 1).length / results.length,
  };
}

function groupBy<K extends string>(
  results: readonly AmaBenchJudgeResult[],
  keyFor: (result: AmaBenchJudgeResult) => K,
): Partial<Record<K, AmaBenchJudgeBucket>> {
  const groups = new Map<K, AmaBenchJudgeResult[]>();
  for (const result of results) {
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
      throw new Error(`Invalid AMA-Bench judge score: ${result.score}`);
    }
    const key = keyFor(result);
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, bucket(values)]),
  ) as Partial<Record<K, AmaBenchJudgeBucket>>;
}

export function aggregateAmaBenchJudgeResults(
  results: readonly AmaBenchJudgeResult[],
): AmaBenchJudgeAggregate {
  // Validate scores even when every grouping would otherwise be empty.
  results.forEach((result) => {
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
      throw new Error(`Invalid AMA-Bench judge score: ${result.score}`);
    }
  });
  return {
    overall: bucket(results),
    byDomain: groupBy(results, (result) => result.domain),
    byTaskType: groupBy(results, (result) => result.taskType),
    byCapability: groupBy(results, (result) => result.capability),
  };
}
