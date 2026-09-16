import { chmod, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AMA_BENCH_ANSWER_PROMPT_TEMPLATE,
  AMA_BENCH_ANSWER_PROMPT_VERSION,
  buildAmaBenchAnswerPrompt,
  type AmaBenchPrivateQuery,
} from "../../../benchmark/amabench/index.js";
import {
  evidenceBenchmarkDataPaths,
  runBenchmarkAnswer,
  BenchmarkAnswerError,
  type BenchmarkAnswerResult,
  type EvidenceBenchmarkFailureRecord,
  type EvidenceBenchmarkId,
  type EvidenceBenchmarkPrediction,
  type EvidenceBenchmarkSuccessRecord,
} from "../../../benchmark/index.js";
import { createReadOnlyScopeNavigation } from "../../../composition/create-read-only-navigation.js";
import { createRetrievalContext } from "../../../composition/create-retrieval-context.js";
import {
  PICORER_HARNESS_VERSION,
  PICORER_SKILL_HASH,
  PICORER_SKILL_VERSION,
  MAX_EVIDENCE_CHARS_PER_MEMORY,
  MAX_READ_RESULT_CHARS,
  MAX_INSPECTED_EVIDENCE_COUNT,
  MAX_INSPECTED_EVIDENCE_CHARS,
  PicorerRunError,
  picorerSystemPrompt,
  runPicorer,
  type PicorerResult,
} from "../../../evidence-agent/index.js";
import { runAsyncPool } from "../../../platform/concurrency/async-pool.js";
import { loadPiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import {
  embeddingProfile,
  type RetrievalProfile,
} from "../../../retrieval/index.js";
import { safePathSegment, sha256 } from "../../../util.js";
import {
  BENCHMARK_MODEL_FLAG_NAMES,
  benchmarkModelOptionsFor,
  benchmarkQuerySetHash,
  benchmarkRuntimeIdentity,
  benchmarkSelectedCorpusHash,
  benchmarkSourceRevision,
  benchmarkSystemicRuntimeFailure,
  ensureBenchmarkRunManifest,
  migrateBenchmarkRunInfrastructure,
} from "../evidence-benchmark-runtime.js";
import {
  assertOnlyFlags,
  optionalFlag,
  positiveIntegerFlag,
  requiredFlag,
  retrievalProfileFor,
  skillFor,
  type ParsedCommand,
} from "../parse-command.js";
import {
  createAtomicTextFile,
  readJsonFileIfPresent,
  writeAtomicJson,
} from "../workflow-files.js";
import { readQuestionRecords } from "../private-records.js";

const DEFAULT_STAGE_TIMEOUT_MS = 1_800_000;
const MAX_STAGE_TIMEOUT_MS = 21_600_000;
const MAX_TURNS = 64;
const MAX_TOOL_CALLS = 80;

type RunnableQuery = AmaBenchPrivateQuery;

interface DatasetManifest {
  schema_version: 1;
  identity: {
    benchmark: EvidenceBenchmarkId;
    split: string;
    track: string;
    source: Record<string, unknown>;
  };
  retrieval: unknown;
  case_count: number;
}

function datasetRetrievalProfile(
  manifest: DatasetManifest,
): RetrievalProfile {
  if (
    typeof manifest.retrieval !== "object" || manifest.retrieval === null ||
    Array.isArray(manifest.retrieval) ||
    !("retrievalProfile" in manifest.retrieval)
  ) {
    throw new Error("Dataset manifest has no retrieval profile");
  }
  const profile = manifest.retrieval.retrievalProfile;
  if (
    profile !== "fts5" &&
    profile !== "picorer-hybrid" &&
    profile !== "picorer-hybrid-qdrant-hnsw-v1"
  ) {
    throw new Error("Dataset manifest has an unsupported retrieval profile");
  }
  return profile;
}

function benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId {
  const value = requiredFlag(parsed, "benchmark");
  if (value !== "ama-bench") {
    throw new Error(`Unknown benchmark: ${value}`);
  }
  return value;
}

function selectQueries(
  queries: readonly RunnableQuery[],
  requestedIds: ReadonlySet<string>,
): RunnableQuery[] {
  const selected = requestedIds.size === 0
    ? [...queries]
    : queries.filter((query) => requestedIds.has(query.questionId));
  if (requestedIds.size > 0 && selected.length !== requestedIds.size) {
    const found = new Set(selected.map((query) => query.questionId));
    const missing = [...requestedIds].filter((id) => !found.has(id));
    throw new Error(`Case is not present in the runner map: ${missing.join(", ")}`);
  }
  if (selected.length === 0) throw new Error("No benchmark cases selected");
  return selected.sort((left, right) =>
    left.questionId.localeCompare(right.questionId)
  );
}

function recordPath(directory: string, caseId: string): string {
  return join(directory, `${safePathSegment(caseId)}.json`);
}

async function directoryHasRecords(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some((name) => name.endsWith(".json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadSuccessRecordIds(
  directory: string,
  benchmark: EvidenceBenchmarkId,
  queries: readonly RunnableQuery[],
): Promise<Set<string>> {
  const values = new Set<string>();
  for (const query of queries) {
    const record = await readJsonFileIfPresent<EvidenceBenchmarkSuccessRecord>(
      recordPath(directory, query.questionId),
    );
    if (record === undefined) continue;
    if (
      record.schema_version !== 1 || record.benchmark !== benchmark ||
      record.case_id !== query.questionId
    ) {
      throw new Error(`Invalid benchmark record: ${query.questionId}`);
    }
    values.add(query.questionId);
  }
  return values;
}

async function materializeArtifacts(options: {
  outputDir: string;
  benchmark: EvidenceBenchmarkId;
  queries: readonly RunnableQuery[];
}): Promise<{ succeeded: number; failed: number }> {
  const recordsDirectory = join(options.outputDir, "records");
  const failuresDirectory = join(options.outputDir, "failure-records");
  const [predictionFile, traceFile, failureFile] = await Promise.all([
    createAtomicTextFile(join(options.outputDir, "predictions.jsonl")),
    createAtomicTextFile(join(options.outputDir, "traces.jsonl")),
    createAtomicTextFile(join(options.outputDir, "failures.jsonl")),
  ]);
  const files = [predictionFile, traceFile, failureFile];
  let succeeded = 0;
  let failed = 0;
  try {
    for (const query of options.queries) {
      const success = await readJsonFileIfPresent<EvidenceBenchmarkSuccessRecord>(
        recordPath(recordsDirectory, query.questionId),
      );
      if (success !== undefined) {
        if (
          success.schema_version !== 1 ||
          success.benchmark !== options.benchmark ||
          success.case_id !== query.questionId
        ) {
          throw new Error(`Invalid benchmark record: ${query.questionId}`);
        }
        await predictionFile.append(`${JSON.stringify(success.prediction)}\n`);
        await traceFile.append(`${JSON.stringify({
          case_id: success.case_id,
          retrieval: success.retrieval,
          answer: success.answer,
        })}\n`);
        succeeded += 1;
        continue;
      }
      const failure = await readJsonFileIfPresent<EvidenceBenchmarkFailureRecord>(
        recordPath(failuresDirectory, query.questionId),
      );
      if (failure !== undefined) {
        await failureFile.append(`${JSON.stringify(failure)}\n`);
        failed += 1;
      }
    }
    for (const file of files) await file.commit();
  } catch (error) {
    await Promise.all(files.map((file) => file.abort()));
    throw error;
  }
  await writeAtomicJson(join(options.outputDir, "results.json"), {
    schema_version: 1,
    benchmark: options.benchmark,
    result_count: succeeded,
    failure_count: failed,
    records_directory: "records",
  });
  return { succeeded, failed };
}

function predictionFor(options: {
  benchmark: EvidenceBenchmarkId;
  query: RunnableQuery;
  retrieval: PicorerResult;
  answer: Awaited<ReturnType<typeof runBenchmarkAnswer>>;
}): EvidenceBenchmarkPrediction {
  return {
    schema_version: 1,
    benchmark: options.benchmark,
    case_id: options.query.questionId,
    scope_id: options.query.scopeId,
    response: { kind: "text", text: options.answer.answer },
    abstention: options.retrieval.status === "insufficient",
    retrieval_status: options.retrieval.status,
    citations: options.retrieval.citations,
    retrieval_model: options.retrieval.retrievalModel,
    answer_model: options.answer.model,
    answer_prompt: {
      adapter: options.answer.promptAdapter,
      version: options.answer.promptVersion,
      hash: options.answer.promptHash,
    },
    run_id: options.retrieval.runId,
  };
}

function answerPromptFor(
  _benchmark: EvidenceBenchmarkId,
  query: RunnableQuery,
  retrieval: PicorerResult,
) {
  return buildAmaBenchAnswerPrompt({ query, retrieval });
}

function modelFlagsForRun(): string[] {
  return [
    ...BENCHMARK_MODEL_FLAG_NAMES,
    ...["retrieval", "answer"].flatMap((role) =>
      BENCHMARK_MODEL_FLAG_NAMES.map((name) => `${role}-${name}`)
    ),
  ];
}

export async function benchmarkEvidence(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "benchmark",
    "data-dir",
    "output-dir",
    "case-id",
    "retrieval-profile",
    "slots",
    "stage-timeout-ms",
    "resume-infrastructure-only",
    "skill",
    ...modelFlagsForRun(),
  ]);
  const benchmark = benchmarkFor(parsed);
  const dataPaths = evidenceBenchmarkDataPaths(requiredFlag(parsed, "data-dir"));
  const outputDir = resolve(requiredFlag(parsed, "output-dir"));
  const dataset = await readJsonFileIfPresent<DatasetManifest>(
    dataPaths.datasetManifest,
  );
  if (dataset === undefined || dataset.schema_version !== 1) {
    throw new Error("Missing or unsupported benchmark dataset manifest");
  }
  if (dataset.identity.benchmark !== benchmark) {
    throw new Error("Data directory benchmark does not match --benchmark");
  }
  const storedQueries = await readQuestionRecords<AmaBenchPrivateQuery>(
    dataPaths.privateQueries,
  );
  const selected = selectQueries(
    storedQueries,
    new Set(parsed.flags.get("case-id") ?? []),
  );

  const runManifestPath = join(outputDir, "run-manifest.json");
  const recordsDirectory = join(outputDir, "records");
  const failuresDirectory = join(outputDir, "failure-records");
  if (
    await readJsonFileIfPresent(runManifestPath) === undefined &&
    (await directoryHasRecords(recordsDirectory) ||
      await directoryHasRecords(failuresDirectory))
  ) {
    throw new Error(
      "Benchmark output contains orphaned records without a run manifest",
    );
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  await Promise.all([
    mkdir(recordsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(failuresDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(recordsDirectory, 0o700),
    chmod(failuresDirectory, 0o700),
  ]);

  const existingRecords = await loadSuccessRecordIds(
    recordsDirectory,
    benchmark,
    selected,
  );
  const pending = selected.filter((query) =>
    !existingRecords.has(query.questionId)
  );
  const ingestedRetrievalProfile = datasetRetrievalProfile(dataset);
  const retrievalProfile = parsed.flags.has("retrieval-profile")
    ? retrievalProfileFor(parsed)
    : ingestedRetrievalProfile;
  if (retrievalProfile !== ingestedRetrievalProfile) {
    throw new Error(
      `Run retrieval profile ${retrievalProfile} does not match ingested ` +
        `profile ${ingestedRetrievalProfile}`,
    );
  }
  const slots = positiveIntegerFlag(parsed, "slots", 1, 256);
  const infrastructureResume = optionalFlag(
    parsed,
    "resume-infrastructure-only",
  );
  if (
    infrastructureResume !== undefined && infrastructureResume !== "true"
  ) {
    throw new Error("--resume-infrastructure-only must be true when provided");
  }
  const stageTimeoutMs = positiveIntegerFlag(
    parsed,
    "stage-timeout-ms",
    DEFAULT_STAGE_TIMEOUT_MS,
    MAX_STAGE_TIMEOUT_MS,
  );
  const skill = skillFor(parsed);
  const rawStore = await MemoryStore.create(dataPaths.database);
  let succeededNow = 0;
  let failedNow = 0;
  let notStarted = 0;
  let settled = 0;
  let halted = false;
  let retrievalMetadata: unknown = { retrievalProfile };
  try {
    const [retrievalRuntime, answerRuntime] = await Promise.all([
      loadPiModelRuntime(benchmarkModelOptionsFor(parsed, "retrieval")),
      loadPiModelRuntime(benchmarkModelOptionsFor(parsed, "answer")),
    ]);
    const contextCount = Math.max(1, Math.min(slots, Math.max(1, pending.length)));
    const contexts = Array.from({ length: contextCount }, () =>
      createRetrievalContext(rawStore, retrievalProfile)
    );
    retrievalMetadata = contexts[0]!.metadata;
    if (
      benchmarkQuerySetHash([retrievalMetadata]) !==
        benchmarkQuerySetHash([dataset.retrieval])
    ) {
      throw new Error(
        "Run retrieval identity does not match the ingested dataset",
      );
    }
    const operatorCatalog = contexts[0]!.operatorRegistry.list();

    if (retrievalProfile !== "fts5") {
      const profile = embeddingProfile(contexts[0]!.embedder!);
      for (const query of selected) {
        const status = rawStore.getEmbeddingIndexStatus(query.scopeId, profile);
        if (status.total === 0 || status.missing !== 0) {
          throw new Error(
            `Embedding preflight failed for scope ${query.scopeId}: ` +
              `${status.indexed}/${status.total} indexed`,
          );
        }
      }
    }

    const answerPrompt = {
      adapter: "ama-bench-v4-openend",
      version: AMA_BENCH_ANSWER_PROMPT_VERSION,
      template_hash: sha256(AMA_BENCH_ANSWER_PROMPT_TEMPLATE),
    };
    const runConfig = {
      benchmark,
      dataset: dataset.identity,
      selected_case_count: selected.length,
      query_set_hash: benchmarkQuerySetHash(selected),
      corpus_hash: await benchmarkSelectedCorpusHash(
        dataPaths.sanitized,
        selected,
      ),
      source_revision: benchmarkSourceRevision(),
      retrieval: retrievalMetadata,
      retrieval_model: benchmarkRuntimeIdentity(retrievalRuntime),
      answer_model: benchmarkRuntimeIdentity(answerRuntime),
      answer_prompt: answerPrompt,
      slots,
      limits: {
        max_run_ms: stageTimeoutMs,
        max_turns: MAX_TURNS,
        max_tool_calls: MAX_TOOL_CALLS,
        max_read_result_chars: MAX_READ_RESULT_CHARS,
        max_evidence_chars_per_memory: MAX_EVIDENCE_CHARS_PER_MEMORY,
        max_selected_evidence_chars: MAX_INSPECTED_EVIDENCE_CHARS,
        max_citations: MAX_INSPECTED_EVIDENCE_COUNT,
      },
      harness_version: PICORER_HARNESS_VERSION,
      search_operator_catalog: {
        operators: operatorCatalog,
        hash: sha256(JSON.stringify(operatorCatalog)),
      },
      skill: {
        mode: skill,
        version: skill === "none" ? null : PICORER_SKILL_VERSION,
        hash: skill === "none" ? null : PICORER_SKILL_HASH,
      },
      retrieval_system_prompt_hash: sha256(
        picorerSystemPrompt(skill, undefined, operatorCatalog),
      ),
    };
    if (infrastructureResume === "true") {
      await migrateBenchmarkRunInfrastructure(
        runManifestPath,
        runConfig,
        ["slots"],
      );
    } else {
      await ensureBenchmarkRunManifest(runManifestPath, runConfig);
    }

    await runAsyncPool(pending, slots, async (query, context) => {
      if (halted) {
        notStarted += 1;
        return;
      }
      let retrieval: PicorerResult | undefined;
      let answer: BenchmarkAnswerResult | undefined;
      try {
        const retrievalContext = contexts[context.slot - 1]!;
        retrieval = await runPicorer({
          store: retrievalContext.store,
          operatorRegistry: retrievalContext.operatorRegistry,
          modelRuntime: retrievalRuntime,
          scopeId: query.scopeId,
          question: query.question,
          ...("questionDate" in query && query.questionDate !== undefined
            ? { questionDate: query.questionDate }
            : {}),
          skill,
          maxRunMs: stageTimeoutMs,
          maxTurns: MAX_TURNS,
          maxToolCalls: MAX_TOOL_CALLS,
          readOnlyNavigation: createReadOnlyScopeNavigation(
            dataPaths.sanitized,
            query.scopeId,
          ),
        });
        answer = await runBenchmarkAnswer({
          modelRuntime: answerRuntime,
          prompt: answerPromptFor(benchmark, query, retrieval),
          maxRunMs: stageTimeoutMs,
        });
        const record: EvidenceBenchmarkSuccessRecord = {
          schema_version: 1,
          benchmark,
          case_id: query.questionId,
          slot: context.slot,
          prediction: predictionFor({ benchmark, query, retrieval, answer }),
          retrieval,
          answer,
        };
        await writeAtomicJson(
          recordPath(recordsDirectory, query.questionId),
          record,
        );
        succeededNow += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure: EvidenceBenchmarkFailureRecord = {
          schema_version: 1,
          benchmark,
          case_id: query.questionId,
          slot: context.slot,
          error: message,
          ...(retrieval === undefined ? {} : { retrieval }),
          ...(answer === undefined ? {} : { answer }),
          ...(error instanceof BenchmarkAnswerError ? { answerDiagnostics: error.diagnostics } : {}),
          ...(error instanceof PicorerRunError
            ? { diagnostics: error.diagnostics }
            : {}),
        };
        await writeAtomicJson(
          recordPath(failuresDirectory, query.questionId),
          failure,
        );
        failedNow += 1;
        if (benchmarkSystemicRuntimeFailure(message)) halted = true;
      } finally {
        settled += 1;
        process.stderr.write(
          `[slot ${context.slot}] [${settled}/${pending.length}] ` +
            `${query.questionId}: settled\n`,
        );
      }
    });
  } finally {
    rawStore.close();
  }

  const materialized = await materializeArtifacts({
    outputDir,
    benchmark,
    queries: selected,
  });
  process.stdout.write(`${JSON.stringify({
    command: "benchmark",
    benchmark,
    retrieval: retrievalMetadata,
    slots,
    stage_timeout_ms: stageTimeoutMs,
    selected: selected.length,
    skipped: selected.length - pending.length,
    succeeded_now: succeededNow,
    failed_now: failedNow,
    not_started: notStarted,
    total_succeeded: materialized.succeeded,
    total_failed: materialized.failed,
    halted,
    predictions_path: join(outputDir, "predictions.jsonl"),
    traces_path: join(outputDir, "traces.jsonl"),
    failures_path: materialized.failed === 0
      ? null
      : join(outputDir, "failures.jsonl"),
  }, null, 2)}\n`);
  if (failedNow > 0 || halted) process.exitCode = 1;
}
