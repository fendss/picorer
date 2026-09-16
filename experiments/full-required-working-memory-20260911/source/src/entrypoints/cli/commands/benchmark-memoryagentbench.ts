import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MEMORY_AGENT_BENCH_ANSWER_PROMPT_VERSION,
  buildMemoryAgentBenchAnswerPrompt,
} from "../../../benchmark/memoryagentbench/answer-contract.js";
import {
  readMemoryAgentBenchQuestions,
  readMemoryAgentBenchSessions,
  type MemoryAgentBenchQuestion,
} from "../../../benchmark/memoryagentbench/dataset.js";
import { runBenchmarkAnswer } from "../../../benchmark/index.js";
import { createRetrievalContext } from "../../../composition/create-retrieval-context.js";
import { publishQdrantGeneration } from "../../../composition/qdrant-retrieval.js";
import { ingestMemorySessions } from "../../../memory/index.js";
import {
  OperatorEvolutionCatalog,
  PICORER_SKILL_HASH,
  PICORER_SKILL_VERSION,
  runPicorer,
  type OperatorEvolutionObservation,
  type OperatorEvolutionSnapshot,
  type PicorerResult,
} from "../../../evidence-agent/index.js";
import {
  loadPiModelRuntime,
  type PiModelRuntime,
} from "../../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import { OpenAICompatibleEmbedder } from "../../../retrieval/adapters/openai/openai-compatible-embedder.js";
import { indexScopeEmbeddings } from "../../../retrieval/index-scope-embeddings.js";
import { safePathSegment, sha256 } from "../../../util.js";
import { benchmarkRuntimeIdentity } from "../evidence-benchmark-runtime.js";
import {
  assertOnlyFlags,
  MODEL_RUNTIME_FLAG_NAMES,
  modelOptionsFor,
  optionalFlag,
  positiveIntegerFlag,
  requiredFlag,
  retrievalProfileFor,
  type ParsedCommand,
} from "../parse-command.js";
import {
  readJsonFileIfPresent,
  writeAtomicJson,
  writeAtomicText,
} from "../workflow-files.js";

export type MemoryAgentBenchEvolutionMode =
  | "static"
  | "ephemeral"
  | "cumulative";

interface RetrievalCheckpoint {
  schemaVersion: 1;
  questionId: string;
  retrieval: PicorerResult;
  evolution?: {
    observation: OperatorEvolutionObservation;
    snapshot: OperatorEvolutionSnapshot;
  };
}

interface CompletedRecord extends RetrievalCheckpoint {
  answer: Awaited<ReturnType<typeof runBenchmarkAnswer>>;
}

const MAX_RUN_MS = 300_000;
const MAX_TURNS = 64;
const MAX_TOOL_CALLS = 80;
const EVOLUTION_CAPACITY = 4;
const EVOLUTION_EXPLORATION_SLOTS = 1;
const EVOLUTION_PROMOTION_QUESTIONS = 2;

function evolutionMode(parsed: ParsedCommand): MemoryAgentBenchEvolutionMode {
  const mode = optionalFlag(parsed, "evolution") ?? "static";
  if (mode !== "static" && mode !== "ephemeral" && mode !== "cumulative") {
    throw new Error(`Unknown operator evolution mode: ${mode}`);
  }
  return mode;
}

function optionalQuestionLimit(parsed: ParsedCommand): number | undefined {
  const raw = optionalFlag(parsed, "question-limit");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_600) {
    throw new Error("--question-limit must be an integer between 1 and 1600");
  }
  return value;
}

function zeroTemperature(runtime: PiModelRuntime): PiModelRuntime {
  return {
    ...runtime,
    streamFn: (model, context, options) =>
      runtime.streamFn(model, context, { ...options, temperature: 0 }),
  };
}

function groupByContext(
  questions: readonly MemoryAgentBenchQuestion[],
): Map<string, MemoryAgentBenchQuestion[]> {
  const grouped = new Map<string, MemoryAgentBenchQuestion[]>();
  for (const question of questions) {
    const bucket = grouped.get(question.contextId) ?? [];
    bucket.push(question);
    grouped.set(question.contextId, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => left.sequence - right.sequence);
  }
  return grouped;
}

function checkpointPath(output: string, questionId: string): string {
  return join(output, "retrieval", `${safePathSegment(questionId)}.json`);
}

function completedPath(output: string, questionId: string): string {
  return join(output, "records", `${safePathSegment(questionId)}.json`);
}

function evolutionPath(output: string, contextId: string): string {
  return join(output, "evolution", `${safePathSegment(contextId)}.json`);
}

async function writePredictions(
  output: string,
  questions: readonly MemoryAgentBenchQuestion[],
): Promise<number> {
  const rows: string[] = [];
  for (const question of questions) {
    const record = await readJsonFileIfPresent<CompletedRecord>(
      completedPath(output, question.questionId),
    );
    if (record === undefined) continue;
    rows.push(JSON.stringify({
      questionId: question.questionId,
      subset: question.contextId.split("/")[0],
      contextId: question.contextId,
      sequence: question.sequence,
      task: question.task,
      track: question.track,
      prediction: record.answer.answer,
      retrievalStatus: record.retrieval.status,
      citations: record.retrieval.citations,
      metrics: record.retrieval.metrics,
      operatorCatalog: record.retrieval.operatorCatalog,
      evolution: record.evolution?.observation,
    }));
  }
  await writeAtomicText(join(output, "predictions.jsonl"), `${rows.join("\n")}${rows.length ? "\n" : ""}`);
  return rows.length;
}

async function ensureManifest(path: string, expected: unknown): Promise<void> {
  const existing = await readJsonFileIfPresent<unknown>(path);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error("MemoryAgentBench output directory belongs to a different run configuration");
  }
  if (existing === undefined) await writeAtomicJson(path, expected);
}

export async function benchmarkMemoryAgentBench(
  parsed: ParsedCommand,
): Promise<void> {
  assertOnlyFlags(parsed, [
    "input-dir",
    "output-dir",
    "subset",
    "evolution",
    "question-limit",
    "max-search-calls",
    "retrieval-profile",
    ...MODEL_RUNTIME_FLAG_NAMES,
  ]);
  const input = resolve(requiredFlag(parsed, "input-dir"));
  const output = resolve(requiredFlag(parsed, "output-dir"));
  const subset = requiredFlag(parsed, "subset");
  const mode = evolutionMode(parsed);
  const questionLimit = optionalQuestionLimit(parsed);
  const maxSearchCalls = positiveIntegerFlag(parsed, "max-search-calls", 4, 16);
  const retrievalProfile = retrievalProfileFor(parsed);
  const allQuestions = await readMemoryAgentBenchQuestions(input, subset);
  const questions = questionLimit === undefined
    ? allQuestions
    : allQuestions.slice(0, questionLimit);
  if (questions.length === 0) throw new Error(`No questions selected for ${subset}`);
  const contexts = groupByContext(questions);
  await mkdir(output, { recursive: true });

  const rawRuntime = await loadPiModelRuntime(modelOptionsFor(parsed));
  const modelRuntime = zeroTemperature(rawRuntime);
  const inputManifest = await readFile(join(input, "manifest.json"));
  const rawStore = await MemoryStore.create(join(output, "memory.sqlite"));
  try {
    for (const [contextId, contextQuestions] of contexts) {
      const sessions = await readMemoryAgentBenchSessions(input, subset, contextId);
      if (new Set(sessions.map((session) => session.scopeId)).size !== 1 ||
          sessions[0]?.scopeId !== contextQuestions[0]?.scopeId) {
        throw new Error(`Context ${contextId} does not match its question scope`);
      }
      await ingestMemorySessions(rawStore, sessions);
    }

    let embedder: OpenAICompatibleEmbedder | undefined;
    if (retrievalProfile !== "fts5") {
      embedder = OpenAICompatibleEmbedder.fromEnvironment();
      for (const contextQuestions of contexts.values()) {
        await indexScopeEmbeddings(rawStore, contextQuestions[0]!.scopeId, embedder);
      }
      if (retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1") {
        await publishQdrantGeneration(
          rawStore,
          embedder,
          [...contexts.values()].map((items) => items[0]!.scopeId),
        );
      }
    }
    const retrieval = createRetrievalContext(rawStore, retrievalProfile, embedder);
    const runManifest = {
      schemaVersion: 1,
      benchmark: "MemoryAgentBench",
      inputManifestSha256: sha256(inputManifest.toString("utf8")),
      subset,
      track: questions[0]!.track,
      questionCount: questions.length,
      questionIdsSha256: sha256(JSON.stringify(questions.map((item) => item.questionId))),
      evolution: {
        mode,
        capacity: EVOLUTION_CAPACITY,
        explorationSlots: EVOLUTION_EXPLORATION_SLOTS,
        promotionQuestions: EVOLUTION_PROMOTION_QUESTIONS,
        resetBoundary: "context",
        signal: "retrieval-result-and-citations-only",
      },
      model: benchmarkRuntimeIdentity(modelRuntime),
      temperature: 0,
      answerPromptVersion: MEMORY_AGENT_BENCH_ANSWER_PROMPT_VERSION,
      retrievalProfile,
      ...(retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1"
        ? { retrievalIdentity: retrieval.metadata }
        : {}),
      maxSearchCalls,
      maxTurns: MAX_TURNS,
      maxToolCalls: MAX_TOOL_CALLS,
      maxRunMs: MAX_RUN_MS,
      skill: { version: PICORER_SKILL_VERSION, hash: PICORER_SKILL_HASH },
      operatorCatalog: {
        operators: retrieval.operatorRegistry.list(),
        hash: sha256(JSON.stringify(retrieval.operatorRegistry.list())),
      },
    };
    await ensureManifest(join(output, "run-manifest.json"), runManifest);

    let newlyCompleted = 0;
    for (const [contextId, contextQuestions] of contexts) {
      const statePath = evolutionPath(output, contextId);
      const restored = mode === "cumulative"
        ? await readJsonFileIfPresent<OperatorEvolutionSnapshot>(statePath)
        : undefined;
      const evolution = restored === undefined
        ? new OperatorEvolutionCatalog({
            capacity: EVOLUTION_CAPACITY,
            explorationSlots: EVOLUTION_EXPLORATION_SLOTS,
            promotionQuestions: EVOLUTION_PROMOTION_QUESTIONS,
          })
        : OperatorEvolutionCatalog.restore(restored);

      for (const question of contextQuestions) {
        if (await readJsonFileIfPresent<CompletedRecord>(completedPath(output, question.questionId)) !== undefined) {
          continue;
        }
        let checkpoint = await readJsonFileIfPresent<RetrievalCheckpoint>(
          checkpointPath(output, question.questionId),
        );
        if (checkpoint === undefined) {
          const definitions = mode === "cumulative"
            ? evolution.definitionsForNextQuestion()
            : [];
          const result = await runPicorer({
            store: retrieval.store,
            operatorRegistry: retrieval.operatorRegistry,
            modelRuntime,
            scopeId: question.scopeId,
            question: question.question,
            skill: "picorer-v0",
            maxRunMs: MAX_RUN_MS,
            maxTurns: MAX_TURNS,
            maxToolCalls: MAX_TOOL_CALLS,
            maxSearchCalls,
            maxOperatorDefinitions: mode === "static" ? 0 : EVOLUTION_CAPACITY,
            operatorDefinitions: definitions,
          });
          if (mode === "cumulative") {
            const observation = evolution.observe(question.questionId, result);
            const snapshot = evolution.snapshot();
            checkpoint = {
              schemaVersion: 1,
              questionId: question.questionId,
              retrieval: result,
              evolution: { observation, snapshot },
            };
            await writeAtomicJson(checkpointPath(output, question.questionId), checkpoint);
            await writeAtomicJson(statePath, snapshot);
          } else {
            checkpoint = {
              schemaVersion: 1,
              questionId: question.questionId,
              retrieval: result,
            };
            await writeAtomicJson(checkpointPath(output, question.questionId), checkpoint);
          }
        }
        const answer = await runBenchmarkAnswer({
          modelRuntime,
          prompt: buildMemoryAgentBenchAnswerPrompt(question, checkpoint.retrieval),
          maxRunMs: MAX_RUN_MS,
        });
        await writeAtomicJson(completedPath(output, question.questionId), {
          ...checkpoint,
          answer,
        } satisfies CompletedRecord);
        newlyCompleted += 1;
        process.stdout.write(`${JSON.stringify({
          questionId: question.questionId,
          mode,
          completed: true,
          searchCalls: checkpoint.retrieval.metrics.searchCalls,
          definitions: checkpoint.retrieval.operatorDefinitions.length,
        })}\n`);
      }
    }
    const completed = await writePredictions(output, questions);
    process.stdout.write(`${JSON.stringify({ subset, mode, selected: questions.length, completed, newlyCompleted })}\n`);
  } finally {
    rawStore.close();
  }
}
