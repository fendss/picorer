import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AMA_BENCH_JUDGE_PROMPT_VERSION,
  aggregateAmaBenchJudgeResults,
  buildAmaBenchEpisodeSubmissions,
  buildAmaBenchEvaluatorInput,
  judgeAmaBenchQuestion,
  type AmaBenchJudgeResult,
  type AmaBenchPrivateLabel,
  type AmaBenchPrivateQuery,
  type AmaBenchQuestionPrediction,
} from "../../../benchmark/amabench/index.js";
import {
  evidenceBenchmarkDataPaths,
  type EvidenceBenchmarkId,
  type EvidenceBenchmarkPrediction,
  type EvidenceBenchmarkSuccessRecord,
} from "../../../benchmark/index.js";
import { runAsyncPool } from "../../../platform/concurrency/async-pool.js";
import { loadPiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import {
  BENCHMARK_MODEL_FLAG_NAMES,
  benchmarkModelOptionsFor,
  benchmarkQuerySetHash,
  benchmarkRuntimeIdentity,
  benchmarkSourceRevision,
  ensureBenchmarkRunManifest,
} from "../evidence-benchmark-runtime.js";
import {
  assertOnlyFlags,
  positiveIntegerFlag,
  requiredFlag,
  type ParsedCommand,
} from "../parse-command.js";
import {
  readJsonFileIfPresent,
  writeAtomicJson,
  writeAtomicText,
} from "../workflow-files.js";
import { readQuestionRecords } from "../private-records.js";
import { safePathSegment, sha256 } from "../../../util.js";

const DEFAULT_STAGE_TIMEOUT_MS = 1_800_000;
const MAX_STAGE_TIMEOUT_MS = 21_600_000;

function benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId {
  const value = requiredFlag(parsed, "benchmark");
  if (value !== "ama-bench") {
    throw new Error(`Unknown benchmark: ${value}`);
  }
  return value;
}

function judgeFlags(): string[] {
  return [
    ...BENCHMARK_MODEL_FLAG_NAMES,
    ...BENCHMARK_MODEL_FLAG_NAMES.map((name) => `judge-${name}`),
  ];
}

async function readPredictions(
  path: string,
  benchmark: EvidenceBenchmarkId,
): Promise<EvidenceBenchmarkPrediction[]> {
  const serialized = await readFile(path, "utf8");
  const values: EvidenceBenchmarkPrediction[] = [];
  const seen = new Set<string>();
  serialized.split(/\r?\n/u).forEach((line, index) => {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new SyntaxError(
        `Invalid prediction JSON at line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`Prediction line ${index + 1} must be an object`);
    }
    const prediction = value as EvidenceBenchmarkPrediction;
    if (
      prediction.schema_version !== 1 || prediction.benchmark !== benchmark ||
      typeof prediction.case_id !== "string" ||
      typeof prediction.response !== "object" || prediction.response === null
    ) {
      throw new TypeError(`Prediction line ${index + 1} has an invalid envelope`);
    }
    if (seen.has(prediction.case_id)) {
      throw new Error(`Duplicate prediction case ID: ${prediction.case_id}`);
    }
    seen.add(prediction.case_id);
    values.push(prediction);
  });
  if (values.length === 0) throw new Error("Prediction file is empty");
  return values.sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function indexedByQuestionId<T extends { questionId: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    if (indexed.has(value.questionId)) {
      throw new Error(`Duplicate ${label} question ID: ${value.questionId}`);
    }
    indexed.set(value.questionId, value);
  }
  return indexed;
}

interface EvaluationDatasetManifest {
  schema_version: 1;
  identity: {
    benchmark: EvidenceBenchmarkId;
    split: string;
    track: string;
    source: Record<string, unknown>;
  };
}

interface SourceRunManifest {
  schema_version: 1;
  config: {
    benchmark: EvidenceBenchmarkId;
    dataset: EvaluationDatasetManifest["identity"];
    query_set_hash: string;
    retrieval_model: Record<string, unknown>;
    answer_model: Record<string, unknown>;
  };
}

interface EvaluationProvenance {
  dataset: EvaluationDatasetManifest["identity"];
  source_run_manifest_hash: string;
  predictions_hash: string;
  prediction_set_hash: string;
  query_set_hash: string;
  label_set_hash: string;
  source_revision: ReturnType<typeof benchmarkSourceRevision>;
}

function validatePredictionScope(
  prediction: EvidenceBenchmarkPrediction,
  expectedScopeId: string,
): void {
  if (prediction.scope_id !== expectedScopeId) {
    throw new Error(
      `Prediction scope mismatch for ${prediction.case_id}: ` +
        `${prediction.scope_id} != ${expectedScopeId}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function directoryHasRecords(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).some((name) => name.endsWith(".json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertPredictionModelMatchesRun(
  prediction: EvidenceBenchmarkPrediction,
  sourceRun: SourceRunManifest,
): void {
  for (const [label, actual, expected] of [
    ["retrieval", prediction.retrieval_model, sourceRun.config.retrieval_model],
    ["answer", prediction.answer_model, sourceRun.config.answer_model],
  ] as const) {
    for (const key of [
      "providerId",
      "modelId",
      "thinkingLevel",
      "transport",
    ] as const) {
      if (actual[key] !== expected[key]) {
        throw new Error(
          `Prediction ${label} model mismatch for ${prediction.case_id}`,
        );
      }
    }
  }
}

async function evaluationProvenance(options: {
  benchmark: EvidenceBenchmarkId;
  dataPaths: ReturnType<typeof evidenceBenchmarkDataPaths>;
  predictionsPath: string;
  predictions: readonly EvidenceBenchmarkPrediction[];
  selectedQueries: readonly unknown[];
  selectedLabels: readonly unknown[];
}): Promise<EvaluationProvenance> {
  const dataset = await readJsonFileIfPresent<EvaluationDatasetManifest>(
    options.dataPaths.datasetManifest,
  );
  if (
    dataset === undefined || dataset.schema_version !== 1 ||
    dataset.identity.benchmark !== options.benchmark
  ) {
    throw new Error("Evaluation data directory has an incompatible manifest");
  }
  const sourceRunPath = join(
    dirname(options.predictionsPath),
    "run-manifest.json",
  );
  const sourceRunText = await readFile(sourceRunPath, "utf8");
  const sourceRun = JSON.parse(sourceRunText) as SourceRunManifest;
  const querySetHash = benchmarkQuerySetHash(options.selectedQueries);
  if (
    sourceRun.schema_version !== 1 ||
    sourceRun.config?.benchmark !== options.benchmark ||
    sourceRun.config.query_set_hash !== querySetHash ||
    benchmarkQuerySetHash([sourceRun.config.dataset]) !==
      benchmarkQuerySetHash([dataset.identity])
  ) {
    throw new Error("Predictions do not match their source run manifest");
  }
  const sourceRecordsDirectory = join(
    dirname(options.predictionsPath),
    "records",
  );
  for (const prediction of options.predictions) {
    assertPredictionModelMatchesRun(prediction, sourceRun);
    const record = await readJsonFileIfPresent<EvidenceBenchmarkSuccessRecord>(
      join(sourceRecordsDirectory, `${safePathSegment(prediction.case_id)}.json`),
    );
    if (
      record === undefined || record.benchmark !== options.benchmark ||
      record.case_id !== prediction.case_id ||
      benchmarkQuerySetHash([record.prediction]) !==
        benchmarkQuerySetHash([prediction])
    ) {
      throw new Error(
        `Prediction is not bound to its source record: ${prediction.case_id}`,
      );
    }
  }
  return {
    dataset: dataset.identity,
    source_run_manifest_hash: sha256(sourceRunText),
    predictions_hash: sha256(await readFile(options.predictionsPath, "utf8")),
    prediction_set_hash: benchmarkQuerySetHash(options.predictions),
    query_set_hash: querySetHash,
    label_set_hash: benchmarkQuerySetHash(options.selectedLabels),
    source_revision: benchmarkSourceRevision(),
  };
}

function judgeRecordPath(directory: string, questionId: string): string {
  return join(directory, `${safePathSegment(questionId)}.json`);
}

export async function evaluateBenchmark(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "benchmark",
    "data-dir",
    "predictions",
    "output",
    "slots",
    "stage-timeout-ms",
    ...judgeFlags(),
  ]);
  const benchmark = benchmarkFor(parsed);
  const dataPaths = evidenceBenchmarkDataPaths(requiredFlag(parsed, "data-dir"));
  const predictionsPath = resolve(requiredFlag(parsed, "predictions"));
  const predictions = await readPredictions(predictionsPath, benchmark);
  const output = resolve(requiredFlag(parsed, "output"));
  const evaluationManifestPath = `${output}.manifest.json`;
  const judgeRecordsDirectory = `${output}.judge-records`;
  const judgeFailuresDirectory = `${output}.judge-failure-records`;
  const existingEvaluationManifest = await readJsonFileIfPresent(
    evaluationManifestPath,
  );
  if (
    existingEvaluationManifest === undefined &&
    (await Promise.all([
      pathExists(output),
      pathExists(`${output}.failures.jsonl`),
      pathExists(`${output}.submission.jsonl`),
      directoryHasRecords(judgeRecordsDirectory),
      directoryHasRecords(judgeFailuresDirectory),
    ])).some(Boolean)
  ) {
    throw new Error(
      "Evaluation artifacts exist without their manifest; use a fresh output path",
    );
  }

  const [queries, labels] = await Promise.all([
    readQuestionRecords<AmaBenchPrivateQuery>(
      dataPaths.privateQueries,
    ),
    readQuestionRecords<AmaBenchPrivateLabel>(
      dataPaths.privateLabels,
    ),
  ]);
  const queryById = indexedByQuestionId(queries, "AMA-Bench query");
  const labelById = indexedByQuestionId(labels, "AMA-Bench label");
  const slots = positiveIntegerFlag(parsed, "slots", 1, 64);
  const stageTimeoutMs = positiveIntegerFlag(
    parsed,
    "stage-timeout-ms",
    DEFAULT_STAGE_TIMEOUT_MS,
    MAX_STAGE_TIMEOUT_MS,
  );
  const selectedQueries: AmaBenchPrivateQuery[] = [];
  const selectedLabels: AmaBenchPrivateLabel[] = [];
  const answerPredictions: AmaBenchQuestionPrediction[] = [];
  const inputs = predictions.map((prediction) => {
    if (prediction.response.kind !== "text") {
      throw new Error(
        `AMA-Bench prediction ${prediction.case_id} is not text`,
      );
    }
    const query = queryById.get(prediction.case_id);
    const label = labelById.get(prediction.case_id);
    if (query === undefined || label === undefined) {
      throw new Error(`Missing AMA-Bench private case: ${prediction.case_id}`);
    }
    validatePredictionScope(prediction, query.scopeId);
    selectedQueries.push(query);
    selectedLabels.push(label);
    const answer: AmaBenchQuestionPrediction = {
      scopeId: query.scopeId,
      episodeId: query.episodeId,
      questionId: query.questionId,
      questionIndex: query.questionIndex,
      answer: prediction.response.text,
    };
    answerPredictions.push(answer);
    return buildAmaBenchEvaluatorInput(query, label, answer);
  });
  const provenance = await evaluationProvenance({
    benchmark,
    dataPaths,
    predictionsPath,
    predictions,
    selectedQueries,
    selectedLabels,
  });
  const judgeRuntime = await loadPiModelRuntime(
    benchmarkModelOptionsFor(parsed, "judge"),
  );
  const judgeIdentity = benchmarkRuntimeIdentity(judgeRuntime);
  await ensureBenchmarkRunManifest(evaluationManifestPath, {
    benchmark,
    judge_model: judgeIdentity,
    judge_prompt_version: AMA_BENCH_JUDGE_PROMPT_VERSION,
    slots,
    stage_timeout_ms: stageTimeoutMs,
    ...provenance,
  });

  const completed = new Map<string, AmaBenchJudgeResult>();
  for (const input of inputs) {
    const record = await readJsonFileIfPresent<AmaBenchJudgeResult>(
      judgeRecordPath(judgeRecordsDirectory, input.question_uuid),
    );
    if (record === undefined) continue;
    if (record.questionId !== input.question_uuid) {
      throw new Error(`Invalid AMA-Bench judge record: ${input.question_uuid}`);
    }
    completed.set(input.question_uuid, record);
  }
  const pending = inputs.filter((input) => !completed.has(input.question_uuid));
  let settled = 0;
  await runAsyncPool(pending, slots, async (input, context) => {
    try {
      const result = await judgeAmaBenchQuestion({
        input,
        modelRuntime: judgeRuntime,
        maxRunMs: stageTimeoutMs,
      });
      await writeAtomicJson(
        judgeRecordPath(judgeRecordsDirectory, input.question_uuid),
        result,
      );
    } catch (error) {
      await writeAtomicJson(
        judgeRecordPath(judgeFailuresDirectory, input.question_uuid),
        {
          schema_version: 1,
          question_id: input.question_uuid,
          slot: context.slot,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      settled += 1;
      process.stderr.write(
        `[judge slot ${context.slot}] [${settled}/${pending.length}] ` +
          `${input.question_uuid}\n`,
      );
    }
  });
  const judged: AmaBenchJudgeResult[] = [];
  const failures: unknown[] = [];
  for (const input of inputs) {
    const result = await readJsonFileIfPresent<AmaBenchJudgeResult>(
      judgeRecordPath(judgeRecordsDirectory, input.question_uuid),
    );
    if (result !== undefined) {
      judged.push(result);
      continue;
    }
    const failure = await readJsonFileIfPresent(
      judgeRecordPath(judgeFailuresDirectory, input.question_uuid),
    );
    if (failure !== undefined) failures.push(failure);
  }
  await writeAtomicText(
    `${output}.failures.jsonl`,
    failures.length === 0
      ? ""
      : `${failures.map((failure) => JSON.stringify(failure)).join("\n")}\n`,
  );
  if (judged.length !== inputs.length) {
    throw new Error(
      `AMA-Bench judging checkpointed ${judged.length}/${inputs.length}; ` +
        `${failures.length} failed`,
    );
  }
  const expectedQuestionCount = provenance.dataset.source["questionCount"];
  const submissionPath =
    typeof expectedQuestionCount === "number" &&
      predictions.length === expectedQuestionCount
      ? `${output}.submission.jsonl`
      : undefined;
  if (submissionPath !== undefined) {
    const submissions = buildAmaBenchEpisodeSubmissions(answerPredictions);
    await writeAtomicText(
      submissionPath,
      `${submissions.map((submission) => JSON.stringify(submission)).join("\n")}\n`,
    );
  }
  const aggregate = aggregateAmaBenchJudgeResults(judged);
  const result = {
    schema_version: 1,
    benchmark,
    judge_model: judgeIdentity,
    aggregate,
    fallback_count: judged.filter((item) => item.fallback.used).length,
    submission_path: submissionPath ?? null,
    results: judged,
    provenance,
  };
  await writeAtomicJson(output, result);
  process.stdout.write(`${JSON.stringify({
    command: "evaluate-benchmark",
    benchmark,
    evaluated: judged.length,
    stage_timeout_ms: stageTimeoutMs,
    output,
    fallback_count: result.fallback_count,
    submission_path: result.submission_path,
    aggregate,
  }, null, 2)}\n`);
}
