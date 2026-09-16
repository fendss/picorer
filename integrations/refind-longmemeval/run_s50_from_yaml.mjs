#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parse } from "yaml";

function recordAt(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a mapping`);
  }
  return value;
}

function stringAt(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringAt(value, path) {
  return value === undefined ? undefined : stringAt(value, path);
}

function integerAt(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${path} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function pathAt(value, path, configDirectory) {
  const raw = stringAt(value, path);
  return isAbsolute(raw) ? raw : resolve(configDirectory, raw);
}

function optionalPathAt(value, path, configDirectory) {
  return value === undefined ? undefined : pathAt(value, path, configDirectory);
}

function modelAt(value, path, defaults = {}) {
  const model = recordAt(value, path);
  return {
    id: stringAt(model.id, `${path}.id`),
    thinkingLevel: optionalStringAt(
      model.thinking_level,
      `${path}.thinking_level`,
    ) ?? defaults.thinkingLevel,
    contextWindow: model.context_window === undefined
      ? defaults.contextWindow
      : integerAt(model.context_window, `${path}.context_window`, 1, 2_000_000),
    maxTokens: model.max_tokens === undefined
      ? defaults.maxTokens
      : integerAt(model.max_tokens, `${path}.max_tokens`, 1, 1_000_000),
  };
}

/** Load one local-only, mode-0600 S50 configuration. */
export function loadS50Yaml(configPath) {
  const absolutePath = resolve(configPath);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`S50 config is not a file: ${absolutePath}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`S50 config must be mode 0600: ${absolutePath}`);
  }
  const parsed = recordAt(
    parse(readFileSync(absolutePath, "utf8")),
    "config",
  );
  if (parsed.schema_version !== 1) {
    throw new Error("config.schema_version must be 1");
  }
  const configDirectory = dirname(absolutePath);
  const paths = recordAt(parsed.paths, "config.paths");
  const source = recordAt(parsed.source, "config.source");
  const credentials = recordAt(parsed.credentials, "config.credentials");
  const generation = recordAt(
    credentials.generation,
    "config.credentials.generation",
  );
  const judge = credentials.judge === undefined
    ? generation
    : recordAt(credentials.judge, "config.credentials.judge");
  const models = recordAt(parsed.models, "config.models");
  const run = recordAt(parsed.run, "config.run");
  const generationBaseUrl = stringAt(
    generation.base_url,
    "config.credentials.generation.base_url",
  ).replace(/\/+$/u, "");
  const judgeBaseUrl = optionalStringAt(
    judge.base_url,
    "config.credentials.judge.base_url",
  )?.replace(/\/+$/u, "") ?? generationBaseUrl;
  if (!generationBaseUrl.startsWith("https://") || !judgeBaseUrl.startsWith("https://")) {
    throw new Error("S50 provider base URLs must use https://");
  }
  return {
    configPath: absolutePath,
    paths: {
      root: pathAt(paths.root, "config.paths.root", configDirectory),
      dataDir: optionalPathAt(
        paths.data_dir,
        "config.paths.data_dir",
        configDirectory,
      ),
      outputDir: pathAt(
        paths.output_dir,
        "config.paths.output_dir",
        configDirectory,
      ),
      evaluatorSource: pathAt(
        paths.evaluator_source,
        "config.paths.evaluator_source",
        configDirectory,
      ),
      embeddingEnv: optionalPathAt(
        paths.embedding_env,
        "config.paths.embedding_env",
        configDirectory,
      ),
    },
    source: {
      commit: stringAt(source.commit, "config.source.commit"),
      fingerprint: stringAt(
        source.fingerprint,
        "config.source.fingerprint",
      ),
    },
    credentials: {
      generation: {
        apiKey: stringAt(
          generation.api_key,
          "config.credentials.generation.api_key",
        ),
        baseUrl: generationBaseUrl,
      },
      judge: {
        apiKey: optionalStringAt(
          judge.api_key,
          "config.credentials.judge.api_key",
        ) ?? stringAt(
          generation.api_key,
          "config.credentials.generation.api_key",
        ),
        baseUrl: judgeBaseUrl,
      },
    },
    models: {
      retrieval: modelAt(models.retrieval, "config.models.retrieval", {
        thinkingLevel: "medium",
        contextWindow: 128_000,
        maxTokens: 4_096,
      }),
      answer: modelAt(models.answer, "config.models.answer", {
        thinkingLevel: "medium",
        contextWindow: 128_000,
        maxTokens: 4_096,
      }),
      judge: modelAt(models.judge, "config.models.judge"),
    },
    run: {
      label: stringAt(run.label, "config.run.label"),
      slots: integerAt(run.slots, "config.run.slots", 1, 256),
      maxSearchCalls: run.max_search_calls === undefined
        ? 4
        : integerAt(
          run.max_search_calls,
          "config.run.max_search_calls",
          1,
          100,
        ),
      expectedQuestions: run.expected_questions === undefined
        ? 50
        : integerAt(
          run.expected_questions,
          "config.run.expected_questions",
          1,
          500,
        ),
      healthRetrySeconds: run.health_retry_seconds === undefined
        ? 60
        : integerAt(
          run.health_retry_seconds,
          "config.run.health_retry_seconds",
          1,
          3_600,
        ),
    },
  };
}

export function environmentForS50(config, inherited = process.env) {
  const environment = {
    ...inherited,
    REFIND_ROOT: config.paths.root,
    REFIND_OUTPUT_DIR: config.paths.outputDir,
    REFIND_EVALUATOR_SOURCE: config.paths.evaluatorSource,
    PICORER_SOURCE_COMMIT: config.source.commit,
    PICORER_SOURCE_FINGERPRINT: config.source.fingerprint,
    OPENAI_API_KEY: config.credentials.generation.apiKey,
    OPENAI_API_BASE: config.credentials.generation.baseUrl,
    REFIND_JUDGE_API_KEY: config.credentials.judge.apiKey,
    REFIND_JUDGE_API_BASE: config.credentials.judge.baseUrl,
    REFIND_RETRIEVAL_MODEL: config.models.retrieval.id,
    REFIND_RETRIEVAL_THINKING_LEVEL: config.models.retrieval.thinkingLevel,
    REFIND_RETRIEVAL_CONTEXT_WINDOW: String(
      config.models.retrieval.contextWindow,
    ),
    REFIND_RETRIEVAL_MAX_TOKENS: String(config.models.retrieval.maxTokens),
    REFIND_ANSWER_MODEL: config.models.answer.id,
    REFIND_ANSWER_THINKING_LEVEL: config.models.answer.thinkingLevel,
    REFIND_ANSWER_CONTEXT_WINDOW: String(config.models.answer.contextWindow),
    REFIND_ANSWER_MAX_TOKENS: String(config.models.answer.maxTokens),
    REFIND_JUDGE_MODEL: config.models.judge.id,
    REFIND_SLOTS: String(config.run.slots),
    REFIND_MAX_SEARCH_CALLS: String(config.run.maxSearchCalls),
    REFIND_EXPECTED_QUESTIONS: String(config.run.expectedQuestions),
    REFIND_HEALTH_RETRY_SECONDS: String(config.run.healthRetrySeconds),
    REFIND_RUN_LABEL: config.run.label,
  };
  if (config.paths.dataDir !== undefined) {
    environment.REFIND_DATA_DIR = config.paths.dataDir;
  }
  if (config.paths.embeddingEnv !== undefined) {
    environment.REFIND_EMBEDDING_ENV = config.paths.embeddingEnv;
  }
  return environment;
}

/** Fail before paid model calls when the evaluator source is the wrong schema. */
export function validateS50Inputs(config) {
  let source;
  try {
    source = JSON.parse(readFileSync(config.paths.evaluatorSource, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read evaluator source ${config.paths.evaluatorSource}`,
      { cause: error },
    );
  }
  if (
    !Array.isArray(source) ||
    source.length === 0 ||
    !Array.isArray(source[0]?.qa) ||
    source[0].qa.length !== 1
  ) {
    throw new Error(
      "Evaluator source must use the original LongMemEval [{sample_id, qa:[...]}] schema",
    );
  }
}

function sanitizedSummary(config) {
  return {
    config: config.configPath,
    root: config.paths.root,
    output: config.paths.outputDir,
    retrieval_model: config.models.retrieval.id,
    answer_model: config.models.answer.id,
    judge_model: config.models.judge.id,
    slots: config.run.slots,
    max_search_calls: config.run.maxSearchCalls,
    credentials: "configured",
  };
}

async function main() {
  const checkOnly = process.argv[2] === "--check";
  const configPath = checkOnly ? process.argv[3] : process.argv[2];
  if (configPath === undefined) {
    throw new Error("Usage: run_s50_from_yaml.mjs [--check] CONFIG.yaml");
  }
  const config = loadS50Yaml(configPath);
  validateS50Inputs(config);
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify(sanitizedSummary(config), null, 2)}\n`);
    return;
  }
  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "run_s50.sh",
  );
  const child = spawn("bash", [scriptPath], {
    env: environmentForS50(config),
    stdio: "inherit",
  });
  const outcome = await new Promise((resolveOutcome, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
  if (outcome.signal !== null) {
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exitCode = outcome.code ?? 1;
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
