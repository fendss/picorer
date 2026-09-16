import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dataPaths } from "../../../benchmark/longmemeval/data-paths.js";
import type { LongMemEvalPrivateQuestion } from "../../../benchmark/longmemeval/dataset-adapter.js";
import { readScopeRecords } from "../private-records.js";
import type { BenchmarkSuccessRecord } from "../../../benchmark/model/benchmark-run.js";
import { PICORER_HARNESS_VERSION } from "../../../evidence-agent/index.js";
import {
  loadProtectedEnvironment,
  requireEnvironmentVariable,
} from "../../../platform/security/protected-environment.js";
import {
  assertOnlyFlags,
  MODEL_RUNTIME_FLAG_NAMES,
  optionalFlag,
  positiveIntegerFlag,
  positiveNumberFlag,
  requiredFlag,
  retrievalProfileFor,
  skillFor,
  type ParsedCommand,
} from "../parse-command.js";
import {
  executeArchiveCommand,
  readJsonFileIfPresent,
  writeAtomicJson,
  writeAtomicText,
} from "../workflow-files.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function jsonRecordCount(directory: string): Promise<number> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith("."),
    ).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function runLoggedChild(options: {
  file: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  logPath: string;
  mirrorStderr?: boolean;
}): Promise<number> {
  await mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const log = createWriteStream(options.logPath, {
    flags: "a",
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(options.logPath, 0o600).catch(() => undefined);
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(options.file, options.args, {
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (options.mirrorStderr ?? true) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      log.end();
      reject(error);
    });
    child.once("close", (code, signal) => {
      log.end(() => {
        if (signal) {
          reject(new Error(`Child process stopped by ${signal}`));
          return;
        }
        resolvePromise(code ?? 1);
      });
    });
  });
}

async function unresolvedFailureMessages(outputDir: string): Promise<string[]> {
  const successes = new Set<string>();
  for (const entry of await readdir(join(outputDir, "records"), {
    withFileTypes: true,
  }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      successes.add(entry.name.slice(0, -5));
    }
  }
  const messages: string[] = [];
  for (const entry of await readdir(join(outputDir, "failure-records"), {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (successes.has(entry.name.slice(0, -5))) continue;
    const failure = await readJsonFileIfPresent<{ error?: unknown }>(
      join(outputDir, "failure-records", entry.name),
    );
    if (typeof failure?.error === "string") messages.push(failure.error);
  }
  return messages;
}

async function auditLongMemEvalSuite(
  outputDir: string,
  expected: number,
): Promise<Record<string, unknown>> {
  const results = JSON.parse(
    await readFile(join(outputDir, "results.json"), "utf8"),
  ) as { result_count?: unknown; results?: BenchmarkSuccessRecord[] };
  if (
    results.result_count !== expected ||
    !Array.isArray(results.results) ||
    results.results.length !== expected
  ) {
    throw new Error("Suite audit found incomplete consolidated results");
  }
  const questionIds = new Set<string>();
  const responseModels = new Map<string, number>();
  const retrievalStatuses = new Map<string, number>();
  let searchedMemories = 0;
  let evidence = 0;
  let citations = 0;
  for (const record of results.results) {
    if (record.schema_version !== 2) {
      throw new Error("Suite audit found an unsupported record schema");
    }
    questionIds.add(record.question_id);
    const retrieval = record.retrieval;
    const candidateIds = new Set(
      retrieval.candidates.map((item) => item.memoryId),
    );
    const evidenceIds = new Set(
      retrieval.evidence.map((item) => item.memoryId),
    );
    const citationIds = new Set(
      retrieval.citations.map((item) => item.memoryId),
    );
    if (
      [...citationIds].some((id) => !evidenceIds.has(id)) ||
      [...evidenceIds].some((id) => !candidateIds.has(id))
    ) {
      throw new Error(`Suite provenance violation: ${record.question_id}`);
    }
    searchedMemories += retrieval.candidates.length;
    evidence += evidenceIds.size;
    citations += citationIds.size;
    retrievalStatuses.set(
      retrieval.status,
      (retrievalStatuses.get(retrieval.status) ?? 0) + 1,
    );
    const responseModel = record.answer.model.responseModel;
    responseModels.set(
      responseModel,
      (responseModels.get(responseModel) ?? 0) + 1,
    );
  }
  if (questionIds.size !== expected) {
    throw new Error("Suite audit found duplicate question IDs");
  }
  const countJsonl = async (name: string): Promise<number> =>
    (await readFile(join(outputDir, name), "utf8"))
      .split("\n")
      .filter(Boolean).length;
  const jsonlCounts = {
    predictions: await countJsonl("predictions.jsonl"),
    traces: await countJsonl("traces.jsonl"),
    failures: await countJsonl("failures.jsonl"),
  };
  if (
    jsonlCounts.predictions !== expected ||
    jsonlCounts.traces !== expected ||
    jsonlCounts.failures !== 0
  ) {
    throw new Error("Suite audit found incomplete JSONL artifacts");
  }
  const audit = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    question_count: expected,
    unique_question_count: questionIds.size,
    provenance_violations: 0,
    jsonl_counts: jsonlCounts,
    retrieval_statuses: Object.fromEntries(retrievalStatuses),
    answer_response_models: Object.fromEntries(responseModels),
    searched_memory_count: searchedMemories,
    evidence_count: evidence,
    citation_count: citations,
  };
  await writeAtomicJson(join(outputDir, "suite-audit.json"), audit);
  return audit;
}

function baselineScores(parsed: ParsedCommand): Array<{
  name: string;
  accuracy: number;
}> {
  return (parsed.flags.get("baseline-score") ?? []).map((raw) => {
    const separator = raw.lastIndexOf("=");
    if (separator <= 0) {
      throw new Error("--baseline-score must use NAME=ACCURACY");
    }
    const name = raw.slice(0, separator).trim();
    const accuracy = Number(raw.slice(separator + 1));
    if (!name || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
      throw new Error("--baseline-score accuracy must be between 0 and 1");
    }
    return { name, accuracy };
  });
}

async function packageEvaluationArtifacts(
  outputDir: string,
  archivePath: string,
): Promise<void> {
  const relativeFiles = [
    "run-manifest.json",
    "suite-audit.json",
    "evaluation/longmemeval-eval.json",
    "evaluation/judge-v5/run-manifest.json",
    "evaluation/judge-v5/results.json",
    "evaluation/judge-v5/summary.json",
    "evaluation/frozen-reanswer/input.json",
    "evaluation/frozen-reanswer/answers/run-manifest.json",
    "evaluation/frozen-reanswer/answers/results.json",
    "evaluation/frozen-reanswer/answers/predictions.jsonl",
    "evaluation/frozen-reanswer/longmemeval-eval.json",
    "evaluation/frozen-reanswer/judge-v5/run-manifest.json",
    "evaluation/frozen-reanswer/judge-v5/results.json",
    "evaluation/frozen-reanswer/judge-v5/summary.json",
    "evaluation/comparison.json",
  ];
  const files = await Promise.all(
    relativeFiles.map(async (path) => {
      const content = await readFile(join(outputDir, path));
      return {
        path,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  const manifestPath = join(
    outputDir,
    "evaluation/evaluation-package-manifest.json",
  );
  await writeAtomicJson(manifestPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    files,
  });
  relativeFiles.push("evaluation/evaluation-package-manifest.json");
  const destination = resolve(archivePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await executeArchiveCommand("/usr/bin/tar", [
    "-czf",
    temporary,
    "-C",
    outputDir,
    ...relativeFiles,
  ]);
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

type SuiteModelRole = "retrieval" | "answer";

export interface SuiteModelRoleConfiguration {
  agentDir?: string;
  modelAdapter?: string;
  contextWindow?: string;
  maxTokens?: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  apiKeySourceEnv: string;
  baseUrlSourceEnv: string;
  transport: string;
}

export interface SuiteModelConfiguration {
  retrieval: SuiteModelRoleConfiguration;
  answer: SuiteModelRoleConfiguration;
}

function roleFlag(
  parsed: ParsedCommand,
  role: SuiteModelRole,
  name: string,
): string | undefined {
  return optionalFlag(parsed, `${role}-${name}`) ?? optionalFlag(parsed, name);
}

function requiredRoleFlag(
  parsed: ParsedCommand,
  role: SuiteModelRole,
  name: string,
): string {
  const value = roleFlag(parsed, role, name);
  if (value === undefined) {
    throw new Error(
      `Expected --${role}-${name} or the legacy --${name} fallback`,
    );
  }
  return value;
}

function modelRoleConfiguration(
  parsed: ParsedCommand,
  role: SuiteModelRole,
): SuiteModelRoleConfiguration {
  const modelAdapter = roleFlag(parsed, role, "model-adapter");
  const agentDir = roleFlag(parsed, role, "agent-dir");
  const contextWindow = roleFlag(parsed, role, "context-window");
  const maxTokens = roleFlag(parsed, role, "max-tokens");
  if (modelAdapter === undefined && agentDir === undefined) {
    throw new Error(
      `Expected --${role}-model-adapter or --${role}-agent-dir`,
    );
  }
  return {
    ...(agentDir === undefined ? {} : { agentDir: resolve(agentDir) }),
    ...(modelAdapter === undefined ? {} : { modelAdapter }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    provider: requiredRoleFlag(parsed, role, "provider"),
    model: requiredRoleFlag(parsed, role, "model"),
    thinkingLevel: roleFlag(parsed, role, "thinking-level") ?? "off",
    apiKeySourceEnv:
      roleFlag(parsed, role, "api-key-env") ?? "OPENAI_API_KEY",
    baseUrlSourceEnv:
      roleFlag(parsed, role, "base-url-env") ?? "OPENAI_API_BASE",
    transport: roleFlag(parsed, role, "transport") ?? "sse",
  };
}

export function suiteModelConfigurationFor(
  parsed: ParsedCommand,
): SuiteModelConfiguration {
  return {
    retrieval: modelRoleConfiguration(parsed, "retrieval"),
    answer: modelRoleConfiguration(parsed, "answer"),
  };
}

function suiteRoleRuntimeArguments(
  role: SuiteModelRole,
  configuration: SuiteModelRoleConfiguration,
  apiKeyEnvironment: string,
  baseUrlEnvironment: string,
): string[] {
  return [
    ...(configuration.agentDir === undefined
      ? []
      : [`--${role}-agent-dir`, configuration.agentDir]),
    ...(configuration.modelAdapter === undefined
      ? []
      : [`--${role}-model-adapter`, configuration.modelAdapter]),
    ...(configuration.contextWindow === undefined
      ? []
      : [`--${role}-context-window`, configuration.contextWindow]),
    ...(configuration.maxTokens === undefined
      ? []
      : [`--${role}-max-tokens`, configuration.maxTokens]),
    `--${role}-provider`,
    configuration.provider,
    `--${role}-model`,
    configuration.model,
    `--${role}-thinking-level`,
    configuration.thinkingLevel,
    `--${role}-api-key-env`,
    apiKeyEnvironment,
    `--${role}-base-url-env`,
    baseUrlEnvironment,
    `--${role}-transport`,
    configuration.transport,
  ];
}

const RETRIEVAL_API_KEY_ENV = "PICORER_RETRIEVAL_API_KEY";
const RETRIEVAL_BASE_URL_ENV = "PICORER_RETRIEVAL_BASE_URL";
const ANSWER_API_KEY_ENV = "PICORER_ANSWER_API_KEY";
const ANSWER_BASE_URL_ENV = "PICORER_ANSWER_BASE_URL";

export function suiteBenchmarkEnvironment(options: {
  retrievalSource: NodeJS.ProcessEnv;
  answerSource: NodeJS.ProcessEnv;
  models: SuiteModelConfiguration;
}): NodeJS.ProcessEnv {
  const retrievalApiKey = requireEnvironmentVariable(
    options.retrievalSource,
    options.models.retrieval.apiKeySourceEnv,
  );
  const retrievalBaseUrl = requireEnvironmentVariable(
    options.retrievalSource,
    options.models.retrieval.baseUrlSourceEnv,
  );
  const answerApiKey = requireEnvironmentVariable(
    options.answerSource,
    options.models.answer.apiKeySourceEnv,
  );
  const answerBaseUrl = requireEnvironmentVariable(
    options.answerSource,
    options.models.answer.baseUrlSourceEnv,
  );
  return {
    ...options.retrievalSource,
    ...options.answerSource,
    [RETRIEVAL_API_KEY_ENV]: retrievalApiKey,
    [RETRIEVAL_BASE_URL_ENV]: retrievalBaseUrl,
    [ANSWER_API_KEY_ENV]: answerApiKey,
    [ANSWER_BASE_URL_ENV]: answerBaseUrl,
    // The frozen re-answer evaluator has a stable OPENAI_* contract. Keep it
    // aligned with the suite's answer role even when the source file uses
    // custom variable names.
    OPENAI_API_KEY: answerApiKey,
    OPENAI_API_BASE: answerBaseUrl,
    OPENAI_MODEL: options.models.answer.model,
  };
}

export async function longMemEvalSuite(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "source",
    "data-dir",
    "output-dir",
    "retrieval-profile",
    "skill",
    "slots",
    ...MODEL_RUNTIME_FLAG_NAMES,
    ...MODEL_RUNTIME_FLAG_NAMES.map((name) => `retrieval-${name}`),
    ...MODEL_RUNTIME_FLAG_NAMES.map((name) => `answer-${name}`),
    "embedding-env",
    "retrieval-env",
    "answer-env",
    "judge-env",
    "retry-delay-seconds",
    "archive",
    "judge-script",
    "judge-slots",
    "frozen-slots",
    "judge-variant",
    "evaluation-archive",
    "baseline-score",
  ]);
  const source = resolve(requiredFlag(parsed, "source"));
  const dataDir = resolve(requiredFlag(parsed, "data-dir"));
  const outputDir = resolve(requiredFlag(parsed, "output-dir"));
  const embeddingEnv = resolve(requiredFlag(parsed, "embedding-env"));
  const answerEnv = resolve(requiredFlag(parsed, "answer-env"));
  const retrievalEnv = resolve(
    optionalFlag(parsed, "retrieval-env") ?? answerEnv,
  );
  const judgeEnvPath = resolve(requiredFlag(parsed, "judge-env"));
  const archive = resolve(requiredFlag(parsed, "archive"));
  const evaluationArchive = resolve(
    requiredFlag(parsed, "evaluation-archive"),
  );
  const slots = positiveIntegerFlag(parsed, "slots", 128, 256);
  const judgeSlots = positiveIntegerFlag(parsed, "judge-slots", 32, 256);
  const frozenSlots = positiveIntegerFlag(parsed, "frozen-slots", 32, 256);
  const retryDelaySeconds = positiveNumberFlag(
    parsed,
    "retry-delay-seconds",
    30,
    3_600,
  );
  const retrievalProfile = retrievalProfileFor(parsed);
  const skill = skillFor(parsed);
  const models = suiteModelConfigurationFor(parsed);
  const judgeScript = resolve(
    optionalFlag(parsed, "judge-script") ??
      "scripts/longmemeval_frozen_eval.py",
  );
  const judgeVariant =
    optionalFlag(parsed, "judge-variant") ?? `${PICORER_HARNESS_VERSION}-full`;
  const configuredBaselines = baselineScores(parsed);
  const questions = await readScopeRecords<LongMemEvalPrivateQuestion>(
    dataPaths(dataDir).privateQuestions,
  );
  const expected = questions.length;
  if (expected === 0) throw new Error("Suite has no private benchmark questions");

  const embeddingEnvironment = await loadProtectedEnvironment([embeddingEnv]);
  const answerSourcePromise = loadProtectedEnvironment(
    [answerEnv],
    embeddingEnvironment,
  );
  const retrievalSourcePromise = retrievalEnv === answerEnv
    ? answerSourcePromise
    : loadProtectedEnvironment([retrievalEnv], embeddingEnvironment);
  const [retrievalSource, answerSource] = await Promise.all([
    retrievalSourcePromise,
    answerSourcePromise,
  ]);
  const benchmarkEnvironment = suiteBenchmarkEnvironment({
    retrievalSource,
    answerSource,
    models,
  });
  const judgeEnvironment = await loadProtectedEnvironment(
    [judgeEnvPath],
    benchmarkEnvironment,
  );

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const statusPath = join(outputDir, "suite-status");
  const suiteLog = join(outputDir, "suite.log");
  const waveLog = join(outputDir, "suite-waves.jsonl");
  await writeAtomicText(statusPath, "running\n");
  await appendFile(suiteLog, "", { mode: 0o600 });
  await appendFile(waveLog, "", { mode: 0o600 });
  await Promise.all([chmod(suiteLog, 0o600), chmod(waveLog, 0o600)]);

  const progressScript = resolve("scripts/benchmark_progress.py");
  let progress: ChildProcess | undefined;
  try {
    progress = spawn(
      "python3",
      [
        progressScript,
        "--records-dir",
        join(outputDir, "records"),
        "--failures-dir",
        join(outputDir, "failure-records"),
        "--status-file",
        statusPath,
        "--progress-file",
        join(outputDir, "benchmark-progress.json"),
        "--total",
        String(expected),
      ],
      {
        env: benchmarkEnvironment,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );

    let wave = 0;
    while (await jsonRecordCount(join(outputDir, "records")) < expected) {
      wave += 1;
      const before = await jsonRecordCount(join(outputDir, "records"));
      await appendFile(
        waveLog,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "start",
          wave,
          completed: before,
        })}\n`,
        { mode: 0o600 },
      );
      await writeAtomicText(statusPath, "running\n");
      const childArgs = [
        resolve(process.argv[1]!),
        "benchmark-longmemeval",
        "--data-dir",
        dataDir,
        "--output-dir",
        outputDir,
        "--retrieval-profile",
        retrievalProfile,
        "--skill",
        skill,
        "--slots",
        String(slots),
        ...suiteRoleRuntimeArguments(
          "retrieval",
          models.retrieval,
          RETRIEVAL_API_KEY_ENV,
          RETRIEVAL_BASE_URL_ENV,
        ),
        ...suiteRoleRuntimeArguments(
          "answer",
          models.answer,
          ANSWER_API_KEY_ENV,
          ANSWER_BASE_URL_ENV,
        ),
      ];
      const code = await runLoggedChild({
        file: process.execPath,
        args: childArgs,
        environment: benchmarkEnvironment,
        logPath: suiteLog,
      });
      const after = await jsonRecordCount(join(outputDir, "records"));
      await appendFile(
        waveLog,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "finish",
          wave,
          exitCode: code,
          completed: after,
        })}\n`,
        { mode: 0o600 },
      );
      if (after >= expected) break;
      const messages = await unresolvedFailureMessages(outputDir);
      if (
        messages.some((message) =>
          /(?:\b401\b|\b403\b|invalid token|unauthori[sz]ed)/iu.test(message),
        )
      ) {
        throw new Error(
          "Suite stopped after a credential/provider mismatch; update the protected retrieval or answer environment before resuming",
        );
      }
      await writeAtomicText(statusPath, "retrying\n");
      await sleep(retryDelaySeconds * 1_000);
    }

    await writeAtomicText(statusPath, "auditing\n");
    await auditLongMemEvalSuite(outputDir, expected);
    await writeAtomicText(statusPath, "packaging-benchmark\n");
    const packageCode = await runLoggedChild({
      file: process.execPath,
      args: [
        resolve(process.argv[1]!),
        "package-benchmark",
        "--output-dir",
        outputDir,
        "--archive",
        archive,
      ],
      environment: benchmarkEnvironment,
      logPath: suiteLog,
    });
    if (packageCode !== 0) throw new Error("Benchmark packaging failed");

    const evaluationDir = join(outputDir, "evaluation");
    const judgeDir = join(evaluationDir, "judge-v5");
    await mkdir(judgeDir, { recursive: true, mode: 0o700 });
    await chmod(judgeDir, 0o700);
    await writeAtomicText(statusPath, "preparing-evaluation\n");
    const prepareCode = await runLoggedChild({
      file: process.execPath,
      args: [
        resolve(process.argv[1]!),
        "prepare-longmemeval-eval",
        "--source",
        source,
        "--predictions",
        join(outputDir, "predictions.jsonl"),
        "--output",
        join(evaluationDir, "longmemeval-eval.json"),
      ],
      environment: benchmarkEnvironment,
      logPath: suiteLog,
    });
    if (prepareCode !== 0) throw new Error("Evaluation preparation failed");

    await writeAtomicText(statusPath, "judging\n");
    const judgeCode = await runLoggedChild({
      file: "python3",
      args: [
        judgeScript,
        "judge",
        "--input",
        join(evaluationDir, "longmemeval-eval.json"),
        "--output-dir",
        judgeDir,
        "--slots",
        String(judgeSlots),
        "--variant",
        judgeVariant,
      ],
      environment: judgeEnvironment,
      logPath: suiteLog,
    });
    if (judgeCode !== 0) throw new Error("Judger v5 failed");

    const judgeSummary = JSON.parse(
      await readFile(join(judgeDir, "summary.json"), "utf8"),
    ) as {
      judge_model?: unknown;
      prompt_hash?: unknown;
      metrics?: {
        overall?: { correct?: unknown; total?: unknown; accuracy?: unknown };
      };
    };
    const overall = judgeSummary.metrics?.overall;
    if (
      typeof overall?.correct !== "number" ||
      overall.total !== expected ||
      typeof overall.accuracy !== "number"
    ) {
      throw new Error("Judger summary is incomplete");
    }
    const frozenDir = join(evaluationDir, "frozen-reanswer");
    const frozenAnswerDir = join(frozenDir, "answers");
    const frozenJudgeDir = join(frozenDir, "judge-v5");
    const frozenVariant = `${judgeVariant}-frozen-searched-memories`;
    await mkdir(frozenJudgeDir, { recursive: true, mode: 0o700 });
    await writeAtomicText(statusPath, "preparing-frozen-reanswer\n");
    const frozenPrepareCode = await runLoggedChild({
      file: "python3",
      args: [
        judgeScript,
        "prepare-frozen-input",
        "--results",
        join(outputDir, "results.json"),
        "--output",
        join(frozenDir, "input.json"),
      ],
      environment: benchmarkEnvironment,
      logPath: suiteLog,
    });
    if (frozenPrepareCode !== 0) {
      throw new Error("Frozen re-answer input preparation failed");
    }
    await writeAtomicText(statusPath, "frozen-reanswer\n");
    const frozenAnswerCode = await runLoggedChild({
      file: "python3",
      args: [
        judgeScript,
        "reanswer",
        "--input",
        join(frozenDir, "input.json"),
        "--output-dir",
        frozenAnswerDir,
        "--slots",
        String(frozenSlots),
      ],
      environment: benchmarkEnvironment,
      logPath: suiteLog,
    });
    if (frozenAnswerCode !== 0) throw new Error("Frozen re-answer failed");

    const frozenPrepareEvalCode = await runLoggedChild({
      file: process.execPath,
      args: [
        resolve(process.argv[1]!),
        "prepare-longmemeval-eval",
        "--source",
        source,
        "--predictions",
        join(frozenAnswerDir, "predictions.jsonl"),
        "--output",
        join(frozenDir, "longmemeval-eval.json"),
      ],
      environment: benchmarkEnvironment,
      logPath: suiteLog,
    });
    if (frozenPrepareEvalCode !== 0) {
      throw new Error("Frozen evaluator preparation failed");
    }
    await writeAtomicText(statusPath, "judging-frozen-reanswer\n");
    const frozenJudgeCode = await runLoggedChild({
      file: "python3",
      args: [
        judgeScript,
        "judge",
        "--input",
        join(frozenDir, "longmemeval-eval.json"),
        "--output-dir",
        frozenJudgeDir,
        "--slots",
        String(judgeSlots),
        "--variant",
        frozenVariant,
      ],
      environment: judgeEnvironment,
      logPath: suiteLog,
    });
    if (frozenJudgeCode !== 0) throw new Error("Frozen Judger v5 failed");

    const frozenSummary = JSON.parse(
      await readFile(join(frozenJudgeDir, "summary.json"), "utf8"),
    ) as {
      judge_model?: unknown;
      prompt_hash?: unknown;
      metrics?: {
        overall?: { correct?: unknown; total?: unknown; accuracy?: unknown };
      };
    };
    const frozenOverall = frozenSummary.metrics?.overall;
    if (
      typeof frozenOverall?.correct !== "number" ||
      frozenOverall.total !== expected ||
      typeof frozenOverall.accuracy !== "number"
    ) {
      throw new Error("Frozen judge summary is incomplete");
    }
    const currentJudgeResults = JSON.parse(
      await readFile(join(judgeDir, "results.json"), "utf8"),
    ) as { results?: Array<{ question_id?: unknown; label?: unknown }> };
    const frozenJudgeResults = JSON.parse(
      await readFile(join(frozenJudgeDir, "results.json"), "utf8"),
    ) as { results?: Array<{ question_id?: unknown; label?: unknown }> };
    if (
      !Array.isArray(currentJudgeResults.results) ||
      !Array.isArray(frozenJudgeResults.results)
    ) {
      throw new Error("Paired judge results are missing");
    }
    const currentLabels = new Map(
      currentJudgeResults.results.map((item) => [item.question_id, item.label]),
    );
    const transitions = {
      both_correct: 0,
      end_to_end_wrong_to_frozen_correct: 0,
      end_to_end_correct_to_frozen_wrong: 0,
      both_wrong: 0,
    };
    for (const item of frozenJudgeResults.results) {
      const currentCorrect = currentLabels.get(item.question_id) === "CORRECT";
      const frozenCorrect = item.label === "CORRECT";
      if (currentCorrect && frozenCorrect) transitions.both_correct += 1;
      else if (!currentCorrect && frozenCorrect) {
        transitions.end_to_end_wrong_to_frozen_correct += 1;
      } else if (currentCorrect && !frozenCorrect) {
        transitions.end_to_end_correct_to_frozen_wrong += 1;
      } else transitions.both_wrong += 1;
    }
    if (
      Object.values(transitions).reduce((sum, value) => sum + value, 0) !==
      expected
    ) {
      throw new Error("Paired comparison is incomplete");
    }

    const currentAccuracy = overall.accuracy;
    const frozenAccuracy = frozenOverall.accuracy;
    const frozenDelta = frozenAccuracy - currentAccuracy;
    const comparison = {
      schema_version: 2,
      generated_at: new Date().toISOString(),
      current: {
        variant: judgeVariant,
        correct: overall.correct,
        total: overall.total,
        accuracy: currentAccuracy,
        judge_model: judgeSummary.judge_model,
        judge_prompt_hash: judgeSummary.prompt_hash,
      },
      frozen_current_retrieval: {
        variant: frozenVariant,
        correct: frozenOverall.correct,
        total: frozenOverall.total,
        accuracy: frozenAccuracy,
        delta_accuracy: Number(frozenDelta.toFixed(6)),
        delta_percentage_points: Number((frozenDelta * 100).toFixed(4)),
        judge_model: frozenSummary.judge_model,
        judge_prompt_hash: frozenSummary.prompt_hash,
      },
      paired_transitions: transitions,
      baselines: configuredBaselines.map((baseline) => {
        const delta = currentAccuracy - baseline.accuracy;
        return {
          ...baseline,
          delta_accuracy: Number(delta.toFixed(6)),
          delta_percentage_points: Number((delta * 100).toFixed(4)),
        };
      }),
    };
    await writeAtomicJson(join(evaluationDir, "comparison.json"), comparison);
    await writeAtomicText(statusPath, "packaging-evaluation\n");
    await packageEvaluationArtifacts(outputDir, evaluationArchive);
    await writeAtomicText(statusPath, "complete\n");
    process.stdout.write(
      `${JSON.stringify({
        command: "longmemeval-suite",
        status: "complete",
        questionCount: expected,
        auditPath: join(outputDir, "suite-audit.json"),
        benchmarkArchive: archive,
        judgeSummary: join(judgeDir, "summary.json"),
        comparisonPath: join(evaluationDir, "comparison.json"),
        evaluationArchive,
      }, null, 2)}\n`,
    );
  } catch (error) {
    await writeAtomicText(statusPath, "failed\n");
    throw error;
  } finally {
    if (progress && progress.exitCode === null) progress.kill("SIGTERM");
  }
}
