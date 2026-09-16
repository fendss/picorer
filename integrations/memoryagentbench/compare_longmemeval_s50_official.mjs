#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  judge,
  officialAnswerText,
  officialLongMemEvalPrompt,
  summary,
} from "./evaluate_longmemeval_official.mjs";
import { loadMemoryAgentBenchYaml } from "./run_from_yaml.mjs";

const MODEL = "gpt-4o";
const OFFICIAL_PROMPT_SOURCE_COMMIT =
  "fe1735de8cf8b9908e1e3d3b5612afc815698062";
const OFFICIAL_PROMPT_SHA256 =
  "2c90b57efc5142071e32e10b3b131bbad6ee37626b6287d007ab1f52a2cdf54d";

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function runPool(units, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, units.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= units.length) return;
        await operation(units[index]);
      }
    });
  await Promise.all(workers);
}

function uniqueBy(rows, field, label) {
  const result = new Map();
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== "string" || key === "" || result.has(key)) {
      throw new Error(`${label} has a missing or duplicate ${field}`);
    }
    result.set(key, row);
  }
  return result;
}

function pairedComparison(rows, leftField, rightField) {
  const counts = {
    both_correct: 0,
    left_only: 0,
    right_only: 0,
    both_wrong: 0,
  };
  for (const row of rows) {
    const left = row[leftField];
    const right = row[rightField];
    if (left && right) counts.both_correct += 1;
    else if (left) counts.left_only += 1;
    else if (right) counts.right_only += 1;
    else counts.both_wrong += 1;
  }
  return {
    ...counts,
    left_correct: counts.both_correct + counts.left_only,
    right_correct: counts.both_correct + counts.right_only,
    total: rows.length,
  };
}

function makeSummary(rows, labelField, modelField) {
  return summary(rows.map((row) => ({
    question_type: row.question_type,
    label: row[labelField],
    response_model: row[modelField],
  })));
}

async function main() {
  const [
    configPath,
    historicalPath,
    previousJudgePath,
    currentSourcePath,
    outputPath,
    rawConcurrency = "64",
  ] = process.argv.slice(2);
  if (!configPath || !historicalPath || !previousJudgePath ||
    !currentSourcePath || !outputPath) {
    throw new Error(
      "Usage: compare_longmemeval_s50_official.mjs CONFIG HISTORICAL_EVAL PREVIOUS_JUDGE CURRENT_SOURCE OUTPUT [CONCURRENCY]",
    );
  }
  const concurrency = Number(rawConcurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) {
    throw new Error("CONCURRENCY must be an integer between 1 and 128");
  }

  const config = loadMemoryAgentBenchYaml(configPath);
  const historical = JSON.parse(readFileSync(resolve(historicalPath), "utf8"));
  const previousJudgeArtifact = JSON.parse(
    readFileSync(resolve(previousJudgePath), "utf8"),
  );
  const currentSource = JSON.parse(readFileSync(resolve(currentSourcePath), "utf8"));
  if (!Array.isArray(historical) || historical.length !== 50) {
    throw new Error("Historical evaluation must contain exactly 50 rows");
  }
  if (!Array.isArray(previousJudgeArtifact.results) ||
    previousJudgeArtifact.results.length !== 50) {
    throw new Error("Previous judge artifact must contain exactly 50 results");
  }
  if (!Array.isArray(currentSource.data) || currentSource.data.length !== 300) {
    throw new Error("Current source artifact must contain exactly 300 rows");
  }
  const historicalByQuestion = uniqueBy(
    historical,
    "question_id",
    "historical evaluation",
  );
  const previousByQuestion = uniqueBy(
    previousJudgeArtifact.results,
    "question_id",
    "previous judge",
  );
  const currentByQuestion = uniqueBy(
    currentSource.data,
    "question_id",
    "current source",
  );
  for (const questionId of historicalByQuestion.keys()) {
    if (!previousByQuestion.has(questionId)) {
      throw new Error(`Previous judge is missing historical question ${questionId}`);
    }
  }
  const overlapIds = new Set(
    [...historicalByQuestion.keys()].filter((questionId) =>
      currentByQuestion.has(questionId)),
  );

  const prior = existsSync(resolve(outputPath))
    ? JSON.parse(readFileSync(resolve(outputPath), "utf8"))
    : undefined;
  const historicalCompleted = new Map();
  const currentCompleted = new Map();
  for (const row of prior?.data ?? []) {
    if (typeof row.historical_gpt4o_label === "boolean") {
      historicalCompleted.set(row.question_id, {
        label: row.historical_gpt4o_label,
        response: row.historical_gpt4o_judge_response,
        responseModel: row.historical_gpt4o_response_model,
        attempts: row.historical_gpt4o_attempts,
      });
    }
    if (typeof row.current_gpt4o_label === "boolean") {
      currentCompleted.set(row.question_id, {
        label: row.current_gpt4o_label,
        response: row.current_gpt4o_judge_response,
        responseModel: row.current_gpt4o_response_model,
        attempts: row.current_gpt4o_attempts,
      });
    }
  }

  const assembledRows = () => historical.flatMap((historicalRow) => {
    const historicalResult = historicalCompleted.get(historicalRow.question_id);
    if (historicalResult === undefined) return [];
    const previous = previousByQuestion.get(historicalRow.question_id);
    const current = currentByQuestion.get(historicalRow.question_id);
    const currentResult = currentCompleted.get(historicalRow.question_id);
    return [{
      question_id: historicalRow.question_id,
      question_type: historicalRow.question_type,
      previous_gpt41_label: previous.score === 1,
      historical_gpt4o_label: historicalResult.label,
      current_gpt4o_label: currentResult?.label ?? null,
      historical_response: historicalRow.response,
      current_response: current?.output ?? null,
      previous_gpt41_judge_response: previous.judge_response,
      historical_gpt4o_judge_response: historicalResult.response,
      current_gpt4o_judge_response: currentResult?.response ?? null,
      historical_gpt4o_response_model: historicalResult.responseModel,
      current_gpt4o_response_model: currentResult?.responseModel ?? null,
      historical_gpt4o_attempts: historicalResult.attempts,
      current_gpt4o_attempts: currentResult?.attempts ?? null,
    }];
  });

  const persist = () => {
    const rows = assembledRows();
    const overlapRows = rows.filter((row) =>
      typeof row.current_gpt4o_label === "boolean");
    const previousRows = rows.filter((row) =>
      typeof row.previous_gpt41_label === "boolean");
    writeJsonAtomic(resolve(outputPath), {
      schema_version: 1,
      benchmark: "LongMemEval-S",
      subset: "historical-best-s50",
      judge_model: MODEL,
      official_prompt_source_commit: OFFICIAL_PROMPT_SOURCE_COMMIT,
      prompt_sha256: OFFICIAL_PROMPT_SHA256,
      historical_source_artifact: resolve(historicalPath),
      previous_judge_artifact: resolve(previousJudgePath),
      current_source_artifact: resolve(currentSourcePath),
      overlap_count: overlapIds.size,
      data: rows,
      previous_gpt41_summary: makeSummary(
        previousRows,
        "previous_gpt41_label",
        "previous_gpt41_response_model",
      ),
      historical_gpt4o_summary: makeSummary(
        rows,
        "historical_gpt4o_label",
        "historical_gpt4o_response_model",
      ),
      current_overlap_gpt4o_summary: makeSummary(
        overlapRows,
        "current_gpt4o_label",
        "current_gpt4o_response_model",
      ),
      judge_comparison: pairedComparison(
        previousRows,
        "previous_gpt41_label",
        "historical_gpt4o_label",
      ),
      method_comparison_on_overlap: pairedComparison(
        overlapRows,
        "historical_gpt4o_label",
        "current_gpt4o_label",
      ),
    });
  };
  persist();

  const units = [];
  for (const historicalRow of historical) {
    if (!historicalCompleted.has(historicalRow.question_id)) {
      units.push({ kind: "historical", historicalRow });
    }
    if (overlapIds.has(historicalRow.question_id) &&
      !currentCompleted.has(historicalRow.question_id)) {
      units.push({ kind: "current", historicalRow });
    }
  }
  let finished = 0;
  await runPool(units, concurrency, async ({ kind, historicalRow }) => {
    const response = kind === "historical"
      ? historicalRow.response
      : currentByQuestion.get(historicalRow.question_id).output;
    const result = await judge({
      baseUrl: config.credentials.generation.baseUrl,
      apiKey: config.credentials.generation.apiKey,
      model: MODEL,
      prompt: officialLongMemEvalPrompt(
        historicalRow.question_type,
        historicalRow.question,
        officialAnswerText([historicalRow.answer]),
        response,
        Boolean(historicalRow.abstention),
      ),
    });
    const target = kind === "historical"
      ? historicalCompleted
      : currentCompleted;
    target.set(historicalRow.question_id, result);
    persist();
    finished += 1;
    if (finished % 10 === 0 || finished === units.length) {
      process.stdout.write(`${JSON.stringify({
        completed_now: finished,
        remaining: units.length - finished,
      })}\n`);
    }
  });
  persist();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
