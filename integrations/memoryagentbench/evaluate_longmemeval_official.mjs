#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { loadMemoryAgentBenchYaml } from "./run_from_yaml.mjs";

const OFFICIAL_PROMPT_SOURCE_COMMIT =
  "fe1735de8cf8b9908e1e3d3b5612afc815698062";
// Stable identifier already used by the prior official-gpt4o evaluation.
const OFFICIAL_PROMPT_SHA256 =
  "2c90b57efc5142071e32e10b3b131bbad6ee37626b6287d007ab1f52a2cdf54d";
const QUERY_PREFIX =
  "Search Archival Memory and answer the question as concisely as you can, using a single phrase if possible.\n\n ";
const QUERY_SUFFIX = " \n\n Answer:";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function judgeArtifactIdentityMatches(prior, expected) {
  const rows = Array.isArray(prior?.data) ? prior.data : [];
  const ids = rows.map((row) => row?.benchmark_query_id);
  return prior?.schema_version === 1 &&
    prior?.benchmark === "MemoryAgentBench" &&
    prior?.dataset === "longmemeval_s*" &&
    prior?.mode === expected.mode &&
    prior?.judge_model === expected.model &&
    prior?.official_prompt_source_commit === OFFICIAL_PROMPT_SOURCE_COMMIT &&
    prior?.prompt_sha256 === OFFICIAL_PROMPT_SHA256 &&
    prior?.source_artifact === expected.sourcePath &&
    prior?.source_artifact_sha256 === expected.sourceArtifactSha256 &&
    ids.every((id) => typeof id === "string") &&
    new Set(ids).size === ids.length;
}

export function judgeRowMatchesPrediction(priorRow, sourceRow, prompt) {
  return priorRow?.source_prediction === sourceRow.output &&
    priorRow?.source_prediction_sha256 === sha256(sourceRow.output) &&
    priorRow?.judge_prompt_sha256 === sha256(prompt);
}

export function originalLongMemEvalQuestion(formattedQuery) {
  if (!formattedQuery.startsWith(QUERY_PREFIX) ||
    !formattedQuery.endsWith(QUERY_SUFFIX)) {
    throw new Error("LongMemEval query does not match the pinned official template");
  }
  return formattedQuery.slice(QUERY_PREFIX.length, -QUERY_SUFFIX.length);
}

function pythonStringRepr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll(quote, `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

export function officialAnswerText(answer) {
  if (!Array.isArray(answer) || !answer.every((item) => typeof item === "string")) {
    throw new Error("LongMemEval answer must be a list of strings");
  }
  return `[${answer.map(pythonStringRepr).join(", ")}]`;
}

export function officialLongMemEvalPrompt(
  questionType,
  question,
  answer,
  response,
  abstention = false,
) {
  const fill = (template) => [question, answer, response].reduce(
    (value, replacement) => value.replace("{}", () => replacement),
    template,
  );
  if (abstention) {
    return fill("I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.");
  }
  if (["single-session-user", "single-session-assistant", "multi-session"]
    .includes(questionType)) {
    return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
  }
  if (questionType === "temporal-reasoning") {
    return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
  }
  if (questionType === "knowledge-update") {
    return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
  }
  if (questionType === "single-session-preference") {
    return fill("I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
  }
  throw new Error(`Unsupported LongMemEval question type: ${questionType}`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function summary(rows) {
  const byQuestionType = {};
  for (const row of rows) {
    const bucket = byQuestionType[row.question_type] ?? { count: 0, correct: 0 };
    bucket.count += 1;
    bucket.correct += row.label ? 1 : 0;
    byQuestionType[row.question_type] = bucket;
  }
  for (const bucket of Object.values(byQuestionType)) {
    bucket.accuracy = bucket.count === 0 ? null : bucket.correct / bucket.count;
  }
  const correct = rows.filter((row) => row.label).length;
  return {
    completed: rows.length,
    correct,
    accuracy: rows.length === 0 ? null : correct / rows.length,
    by_question_type: byQuestionType,
    response_models: [...new Set(rows.map((row) => row.response_model).filter(Boolean))]
      .sort(),
  };
}

export async function judge({ baseUrl, apiKey, model, prompt }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          n: 1,
          temperature: 0,
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        if (response.status === 408 || response.status === 409 ||
          response.status === 425 || response.status === 429 ||
          response.status >= 500) {
          throw new Error(`retryable HTTP ${response.status}`);
        }
        throw new Error(`non-retryable HTTP ${response.status}`);
      }
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("retryable empty judge response");
      }
      return {
        label: content.toLowerCase().includes("yes"),
        response: content.trim(),
        responseModel: typeof body.model === "string" ? body.model : model,
        attempts,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("non-retryable")) {
        throw error;
      }
      const delay = Math.min(2 ** Math.min(attempts - 1, 5), 30) * 1000;
      await new Promise((done) => setTimeout(done, delay + Math.random() * 500));
    }
  }
}

async function runPool(units, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, units.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= units.length) return;
        await operation(units[index], index);
      }
    });
  await Promise.all(workers);
}

async function main() {
  const [configPath, sourceDirectory, outputDirectory, rawConcurrency = "64"] =
    process.argv.slice(2);
  if (!configPath || !sourceDirectory || !outputDirectory) {
    throw new Error(
      "Usage: evaluate_longmemeval_official.mjs CONFIG SOURCE_DIR OUTPUT_DIR [CONCURRENCY]",
    );
  }
  const concurrency = Number(rawConcurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error("CONCURRENCY must be an integer between 1 and 256");
  }
  const config = loadMemoryAgentBenchYaml(configPath);
  const model = "gpt-4o";
  const units = [];
  const states = new Map();
  for (const mode of config.run.modes) {
    const sourcePath = resolve(sourceDirectory, `longmemeval-s-${mode}.json`);
    const sourceBytes = readFileSync(sourcePath);
    const sourceArtifactSha256 = sha256(sourceBytes);
    const source = JSON.parse(sourceBytes.toString("utf8"));
    if (!Array.isArray(source.data) || source.data.length !== 300) {
      throw new Error(`${sourcePath} must contain exactly 300 rows`);
    }
    const outputPath = resolve(outputDirectory, `longmemeval-s-${mode}.json`);
    const prior = existsSync(outputPath)
      ? JSON.parse(readFileSync(outputPath, "utf8"))
      : undefined;
    const priorRows = Array.isArray(prior?.data) ? prior.data : [];
    const reusablePrior = judgeArtifactIdentityMatches(prior, {
      mode,
      model,
      sourcePath,
      sourceArtifactSha256,
    });
    const priorById = new Map(
      (reusablePrior ? priorRows : []).map((row) => [row.benchmark_query_id, row]),
    );
    const completed = new Map();
    for (const row of source.data) {
      const priorRow = priorById.get(row.benchmark_query_id);
      const prompt = officialLongMemEvalPrompt(
        row.question_type,
        originalLongMemEvalQuestion(row.query),
        officialAnswerText(row.answer),
        row.output,
        String(row.question_id).includes("_abs"),
      );
      if (judgeRowMatchesPrediction(priorRow, row, prompt)) {
        completed.set(row.benchmark_query_id, priorRow);
      }
    }
    const state = {
      mode,
      sourcePath,
      sourceArtifactSha256,
      outputPath,
      source,
      completed,
    };
    states.set(mode, state);
    for (const row of source.data) {
      if (!completed.has(row.benchmark_query_id)) units.push({ state, row });
    }
  }

  let finishedNow = 0;
  const persist = (state) => {
    const data = state.source.data.flatMap((row) => {
      const result = state.completed.get(row.benchmark_query_id);
      return result === undefined ? [] : [result];
    });
    writeJsonAtomic(state.outputPath, {
      schema_version: 1,
      benchmark: "MemoryAgentBench",
      dataset: "longmemeval_s*",
      mode: state.mode,
      judge_model: model,
      official_prompt_source_commit: OFFICIAL_PROMPT_SOURCE_COMMIT,
      prompt_sha256: OFFICIAL_PROMPT_SHA256,
      source_artifact: state.sourcePath,
      source_artifact_sha256: state.sourceArtifactSha256,
      data,
      summary: summary(data),
    });
  };
  for (const state of states.values()) persist(state);

  await runPool(units, concurrency, async ({ state, row }) => {
    const prompt = officialLongMemEvalPrompt(
      row.question_type,
      originalLongMemEvalQuestion(row.query),
      officialAnswerText(row.answer),
      row.output,
      String(row.question_id).includes("_abs"),
    );
    const result = await judge({
      baseUrl: config.credentials.generation.baseUrl,
      apiKey: config.credentials.generation.apiKey,
      model,
      prompt,
    });
    state.completed.set(row.benchmark_query_id, {
      benchmark_query_id: row.benchmark_query_id,
      question_id: row.question_id,
      question_type: row.question_type,
      source_prediction: row.output,
      source_prediction_sha256: sha256(row.output),
      judge_prompt_sha256: sha256(prompt),
      label: result.label,
      judge_response: result.response,
      response_model: result.responseModel,
      attempts: result.attempts,
    });
    persist(state);
    finishedNow += 1;
    if (finishedNow % 10 === 0 || finishedNow === units.length) {
      process.stdout.write(`${JSON.stringify({
        completed_now: finishedNow,
        remaining: units.length - finishedNow,
      })}\n`);
    }
  });

  for (const state of states.values()) persist(state);
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    results: [...states.values()].map((state) => ({
      mode: state.mode,
      output: state.outputPath,
      summary: summary([...state.completed.values()]),
    })),
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
