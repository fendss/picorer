#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const ANSWER_HANDOFF_ID = "evidence-aware-v1";
const ANSWER_PROMPT_VERSION =
  "memoryarena-public-budgeted-full-parent-no-summary-no-status-20260831-v3";
const QDRANT_RETRIEVAL_PROFILE = "picorer-hybrid-qdrant-hnsw-v1";

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

function integerAt(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalIntegerAt(value, path, minimum, maximum) {
  return value === undefined || value === null
    ? null
    : integerAt(value, path, minimum, maximum);
}

const TASK_QUESTION_COUNTS = Object.freeze({
  "ruler-qa1": 100,
  "ruler-qa2": 100,
  "longmemeval-s": 300,
  "trec-coarse": 100,
  "trec-fine": 100,
  banking77: 100,
  nlu: 100,
  clinic150: 100,
  "recsys-redial-full": 200,
  "infbench-sum": 100,
  "detective-qa": 71,
  "fact-sh-6k": 100,
  "fact-mh-6k": 100,
  "fact-sh-262k": 100,
  "fact-mh-262k": 100,
  "eventqa-64k": 500,
  "eventqa-full": 500,
});

function tasksAt(run) {
  const values = run.tasks ?? (run.task === undefined ? undefined : [run.task]);
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("config.run.tasks must be a non-empty list");
  }
  const tasks = values.map((value, index) =>
    stringAt(value, `config.run.tasks[${String(index)}]`)
  );
  if (new Set(tasks).size !== tasks.length) {
    throw new Error("config.run.tasks must not contain duplicates");
  }
  for (const task of tasks) {
    if (!(task in TASK_QUESTION_COUNTS)) throw new Error(`Unsupported task: ${task}`);
  }
  return tasks;
}

function pathAt(value, path, configDirectory) {
  const raw = stringAt(value, path);
  return isAbsolute(raw) ? raw : resolve(configDirectory, raw);
}

function optionalFilePathAt(value, path, configDirectory) {
  if (value === undefined || value === null) return null;
  const file = pathAt(value, path, configDirectory);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${path} must identify an existing file: ${file}`);
  }
  return file;
}

function taskPathMapAt(value, path, configDirectory, tasks) {
  if (value === undefined || value === null) return {};
  const mapping = recordAt(value, path);
  const result = {};
  for (const [task, source] of Object.entries(mapping)) {
    if (!tasks.includes(task)) {
      throw new TypeError(`${path} contains unconfigured task ${task}`);
    }
    result[task] = pathAt(source, `${path}.${task}`, configDirectory);
  }
  return result;
}

function optionalStringAt(value, path, fallback) {
  return value === undefined ? fallback : stringAt(value, path);
}

function skillAt(value, path) {
  const skill = optionalStringAt(value, path, "picorer-v0");
  if (!["none", "picorer-minimal", "picorer-v0"].includes(skill)) {
    throw new TypeError(`${path} must be none, picorer-minimal, or picorer-v0`);
  }
  return skill;
}

function interfaceModeAt(value, path, skill) {
  const fallback = skill === "picorer-minimal" ? "compact" : "full";
  const mode = optionalStringAt(value, path, fallback);
  if (!["full", "compact"].includes(mode)) {
    throw new TypeError(`${path} must be full or compact`);
  }
  return mode;
}

function stringListAt(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be a list`);
  const result = value.map((item, index) => stringAt(item, `${path}[${String(index)}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function adaptiveLaneAt(value, path, querySlots) {
  const adaptive = recordAt(value, path);
  const minimum = adaptive.minimum === undefined
    ? 1
    : integerAt(
        adaptive.minimum,
        `${path}.minimum`,
        1,
        querySlots,
      );
  const maximum = adaptive.maximum === undefined
    ? querySlots
    : integerAt(
        adaptive.maximum,
        `${path}.maximum`,
        minimum,
        querySlots,
      );
  const initial = adaptive.initial === undefined
    ? minimum
    : integerAt(
        adaptive.initial,
        `${path}.initial`,
        minimum,
        maximum,
      );
  const successesPerIncrease = adaptive.successes_per_increase === undefined
    ? 8
    : integerAt(
        adaptive.successes_per_increase,
        `${path}.successes_per_increase`,
        1,
        10_000,
      );
  return { minimum, initial, maximum, successesPerIncrease };
}

function adaptiveQuerySlotsAt(value, querySlots) {
  if (value === undefined || value === null) return null;
  const path = "config.run.adaptive_query_slots";
  const adaptive = recordAt(value, path);
  const nested = adaptive.retrieval !== undefined || adaptive.answer !== undefined;
  if (!nested) return adaptiveLaneAt(adaptive, path, querySlots);
  if (adaptive.retrieval === undefined || adaptive.answer === undefined) {
    throw new TypeError(`${path} must configure both retrieval and answer`);
  }
  if (["minimum", "initial", "maximum", "successes_per_increase"].some(
    (field) => adaptive[field] !== undefined
  )) {
    throw new TypeError(`${path} must not mix shared and stage-specific fields`);
  }
  return {
    retrieval: adaptiveLaneAt(adaptive.retrieval, `${path}.retrieval`, querySlots),
    answer: adaptiveLaneAt(adaptive.answer, `${path}.answer`, querySlots),
  };
}

function adaptiveStageValues(value) {
  if (value === null) return null;
  return value.retrieval === undefined
    ? { retrieval: value, answer: value }
    : value;
}

function sameAdaptiveLane(left, right) {
  return ["minimum", "initial", "maximum", "successesPerIncrease"].every(
    (field) => left[field] === right[field]
  );
}

function adaptiveRunnerArguments(value) {
  if (value === null) return [];
  const stages = adaptiveStageValues(value);
  if (sameAdaptiveLane(stages.retrieval, stages.answer)) {
    return [
      "--adaptive-query-slots",
      "--adaptive-query-slots-minimum", String(stages.retrieval.minimum),
      "--adaptive-query-slots-initial", String(stages.retrieval.initial),
      "--adaptive-query-slots-successes-per-increase",
      String(stages.retrieval.successesPerIncrease),
      ...(stages.retrieval.maximum === undefined
        ? []
        : ["--adaptive-retrieval-slots-maximum", String(stages.retrieval.maximum),
          "--adaptive-answer-slots-maximum", String(stages.answer.maximum)]),
    ];
  }
  return [
    "--adaptive-query-slots",
    ...["retrieval", "answer"].flatMap((stage) => [
      `--adaptive-${stage}-slots-minimum`, String(stages[stage].minimum),
      `--adaptive-${stage}-slots-initial`, String(stages[stage].initial),
      `--adaptive-${stage}-slots-maximum`, String(stages[stage].maximum),
      `--adaptive-${stage}-slots-successes-per-increase`,
      String(stages[stage].successesPerIncrease),
    ]),
  ];
}

function modelAt(value, path) {
  const model = recordAt(value, path);
  return {
    id: stringAt(model.id, `${path}.id`),
    routeId: optionalStringAt(model.route_id, `${path}.route_id`, model.id),
    protocol: stringAt(model.protocol, `${path}.protocol`),
    thinkingLevel: optionalStringAt(model.thinking_level, `${path}.thinking_level`, "off"),
    contextWindow: model.context_window === undefined
      ? 128_000
      : integerAt(model.context_window, `${path}.context_window`, 1, 2_000_000),
    maxTokens: model.max_tokens === undefined
      ? 4_096
      : integerAt(model.max_tokens, `${path}.max_tokens`, 1, 1_000_000),
    contextSafetyTokens: model.context_safety_tokens === undefined
      ? 1_024
      : integerAt(
          model.context_safety_tokens,
          `${path}.context_safety_tokens`,
          0,
          1_000_000,
        ),
  };
}

function retrievalProfileAt(value, path) {
  const profile = optionalStringAt(value, path, "picorer-hybrid");
  if (!["picorer-hybrid", QDRANT_RETRIEVAL_PROFILE].includes(profile)) {
    throw new TypeError(
      `${path} must be picorer-hybrid or ${QDRANT_RETRIEVAL_PROFILE}`,
    );
  }
  return profile;
}

function qdrantAt(value, path, retrievalProfile) {
  if (retrievalProfile !== QDRANT_RETRIEVAL_PROFILE) {
    if (value !== undefined && value !== null) {
      throw new TypeError(`${path} requires ${QDRANT_RETRIEVAL_PROFILE}`);
    }
    return null;
  }
  const qdrant = recordAt(value, path);
  return {
    url: stringAt(qdrant.url, `${path}.url`).replace(/\/+$/u, ""),
    apiKey: qdrant.api_key === undefined
      ? undefined
      : stringAt(qdrant.api_key, `${path}.api_key`),
    collection: optionalStringAt(
      qdrant.collection,
      `${path}.collection`,
      "picorer_vectors_v1",
    ),
    vectorGenerationId: stringAt(
      qdrant.vector_generation_id,
      `${path}.vector_generation_id`,
    ),
    requestTimeoutMs: qdrant.request_timeout_ms === undefined
      ? 120_000
      : integerAt(qdrant.request_timeout_ms, `${path}.request_timeout_ms`, 1, 600_000),
    hnswM: qdrant.hnsw_m === undefined
      ? 32
      : integerAt(qdrant.hnsw_m, `${path}.hnsw_m`, 1, 256),
    efConstruct: qdrant.ef_construct === undefined
      ? 200
      : integerAt(qdrant.ef_construct, `${path}.ef_construct`, 1, 10_000),
    hnswEf: qdrant.hnsw_ef === undefined
      ? 800
      : integerAt(qdrant.hnsw_ef, `${path}.hnsw_ef`, 1, 10_000),
    fullScanThresholdKb: qdrant.full_scan_threshold_kb === undefined
      ? 1_000
      : integerAt(
          qdrant.full_scan_threshold_kb,
          `${path}.full_scan_threshold_kb`,
          1,
          1_000_000_000,
        ),
    indexingThresholdKb: qdrant.indexing_threshold_kb === undefined
      ? 10_000
      : integerAt(
          qdrant.indexing_threshold_kb,
          `${path}.indexing_threshold_kb`,
          1,
          1_000_000_000,
        ),
    syncBatchSize: qdrant.sync_batch_size === undefined
      ? 512
      : integerAt(qdrant.sync_batch_size, `${path}.sync_batch_size`, 1, 10_000),
    syncConcurrency: qdrant.sync_concurrency === undefined
      ? 4
      : integerAt(qdrant.sync_concurrency, `${path}.sync_concurrency`, 1, 64),
    verificationPollMs: qdrant.verification_poll_ms === undefined
      ? 1_000
      : integerAt(
          qdrant.verification_poll_ms,
          `${path}.verification_poll_ms`,
          1,
          60_000,
        ),
    verificationTimeoutMs: qdrant.verification_timeout_ms === undefined
      ? 3_600_000
      : integerAt(
          qdrant.verification_timeout_ms,
          `${path}.verification_timeout_ms`,
          1,
          86_400_000,
        ),
  };
}

/** Loads the single protected configuration used by both service and runner. */
export function loadMemoryAgentBenchYaml(configPath) {
  const absolutePath = resolve(configPath);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Config is not a file: ${absolutePath}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`MemoryAgentBench config must be mode 0600: ${absolutePath}`);
  }
  const parsed = recordAt(parse(readFileSync(absolutePath, "utf8")), "config");
  if (parsed.schema_version !== 1) throw new Error("config.schema_version must be 1");
  const configDirectory = dirname(absolutePath);
  const paths = recordAt(parsed.paths, "config.paths");
  const credentials = recordAt(parsed.credentials, "config.credentials");
  const generation = recordAt(credentials.generation, "config.credentials.generation");
  const models = recordAt(parsed.models, "config.models");
  const service = recordAt(parsed.service, "config.service");
  const run = recordAt(parsed.run, "config.run");
  if (stringListAt(
    run.retry_error_codes,
    "config.run.retry_error_codes",
  ).length > 0) {
    throw new Error(
      "config.run.retry_error_codes is not supported; method failures are final",
    );
  }
  const modes = run.modes;
  if (!Array.isArray(modes) || modes.some((mode) =>
    !["static", "ephemeral", "cumulative"].includes(mode)
  )) {
    throw new Error("config.run.modes must contain only static, ephemeral, cumulative");
  }
  const baseUrl = stringAt(
    generation.base_url,
    "config.credentials.generation.base_url",
  ).replace(/\/+$/u, "");
  if (!baseUrl.startsWith("https://")) {
    throw new Error("config.credentials.generation.base_url must use https://");
  }
  const caBundle = optionalFilePathAt(
    generation.ca_bundle,
    "config.credentials.generation.ca_bundle",
    configDirectory,
  );
  const querySlots = optionalIntegerAt(
    run.query_slots,
    "config.run.query_slots",
    1,
    256,
  ) ?? 1;
  const suiteSlots = integerAt(run.slots, "config.run.slots", 1, 256);
  const adaptiveQuerySlots = adaptiveQuerySlotsAt(
    run.adaptive_query_slots,
    querySlots,
  );
  if (adaptiveQuerySlots !== null && suiteSlots !== 1) {
    throw new Error(
      "config.run.slots must be 1 when adaptive_query_slots is enabled",
    );
  }
  const tasks = tasksAt(run);
  const retrievalProfile = retrievalProfileAt(
    service.retrieval_profile,
    "config.service.retrieval_profile",
  );
  const qdrant = qdrantAt(
    service.qdrant,
    "config.service.qdrant",
    retrievalProfile,
  );
  const skill = skillAt(service.skill, "config.service.skill");
  const requireWorkingMemory = service.require_working_memory ?? false;
  if (typeof requireWorkingMemory !== "boolean") throw new Error("config.service.require_working_memory must be boolean");
  const interfaceMode = interfaceModeAt(
    service.interface_mode,
    "config.service.interface_mode",
    skill,
  );
  return {
    configPath: absolutePath,
    paths: {
      root: pathAt(paths.root, "config.paths.root", configDirectory),
      source: pathAt(paths.source, "config.paths.source", configDirectory),
      dataDir: pathAt(paths.data_dir, "config.paths.data_dir", configDirectory),
      outputDir: pathAt(paths.output_dir, "config.paths.output_dir", configDirectory),
      runtimeDir: pathAt(paths.runtime_dir, "config.paths.runtime_dir", configDirectory),
      nltkData: pathAt(paths.nltk_data, "config.paths.nltk_data", configDirectory),
      embeddingEnv: pathAt(paths.embedding_env, "config.paths.embedding_env", configDirectory),
      node: optionalStringAt(paths.node, "config.paths.node", "node"),
      uv: optionalStringAt(paths.uv, "config.paths.uv", "uv"),
    },
    credentials: {
      generation: {
        apiKey: stringAt(generation.api_key, "config.credentials.generation.api_key"),
        baseUrl,
        caBundle,
      },
    },
    models: {
      retrieval: modelAt(models.retrieval, "config.models.retrieval"),
      answer: modelAt(models.answer, "config.models.answer"),
    },
    service: {
      host: stringAt(service.host, "config.service.host"),
      port: integerAt(service.port, "config.service.port", 1, 65_535),
      sourceIdentity: stringAt(
        service.source_identity,
        "config.service.source_identity",
      ),
      buildIdentity: stringAt(
        service.build_identity,
        "config.service.build_identity",
      ),
      retrievalProfile,
      qdrant,
      skill,
      interfaceMode,
      requireWorkingMemory,
      maxRunMs: integerAt(service.max_run_ms, "config.service.max_run_ms", 1, 1_800_000),
      maxTurns: integerAt(service.max_turns, "config.service.max_turns", 1, 256),
      maxToolCalls: integerAt(service.max_tool_calls, "config.service.max_tool_calls", 1, 512),
      maxConcurrentWraps: optionalIntegerAt(
        service.max_concurrent_wraps,
        "config.service.max_concurrent_wraps",
        1,
        256,
      ) ?? 16,
      requestTimeoutMs: optionalIntegerAt(
        service.request_timeout_ms,
        "config.service.request_timeout_ms",
        1,
        1_800_000,
      ) ?? 120_000,
    },
    run: {
      tasks,
      label: optionalStringAt(run.label, "config.run.label", "yaml-run"),
      modes: [...modes],
      maxSearchCalls: integerAt(run.max_search_calls, "config.run.max_search_calls", 1, 16),
      maxContexts: optionalIntegerAt(run.max_contexts, "config.run.max_contexts", 1, 1_000_000),
      maxQueries: optionalIntegerAt(run.max_queries, "config.run.max_queries", 1, 1_000_000),
      slots: suiteSlots,
      contextSlots: optionalIntegerAt(
        run.context_slots,
        "config.run.context_slots",
        1,
        64,
      ) ?? 1,
      querySlots,
      adaptiveQuerySlots,
      retryDelaySeconds: optionalIntegerAt(
        run.retry_delay_seconds,
        "config.run.retry_delay_seconds",
        1,
        3600,
      ) ?? 60,
      answerTimeoutSeconds: optionalIntegerAt(
        run.answer_timeout_seconds,
        "config.run.answer_timeout_seconds",
        1,
        86_400,
      ) ?? 120,
      memoryTimeoutSeconds: optionalIntegerAt(
        run.memory_timeout_seconds,
        "config.run.memory_timeout_seconds",
        1,
        86_400,
      ) ?? Math.ceil(
        integerAt(service.max_run_ms, "config.service.max_run_ms", 1, 1_800_000) /
          1_000,
      ) + 30,
      reuseIngestionFrom: taskPathMapAt(
        run.reuse_ingestion_from,
        "config.run.reuse_ingestion_from",
        configDirectory,
        tasks,
      ),
    },
  };
}

function skillFile(config) {
  if (config.service.skill === "none") return null;
  const directory = config.service.skill === "picorer-minimal"
    ? "picorer-retrieval-minimal"
    : "picorer-retrieval";
  return join(config.paths.source, ".agents", "skills", directory, "SKILL.md");
}

function embeddingInteger(environment, name, fallback) {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function embeddingEndpoint(baseUrl) {
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new TypeError("PICORER_EMBEDDING_BASE_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username || endpoint.password) {
    throw new TypeError(
      "PICORER_EMBEDDING_BASE_URL must be an HTTP(S) URL without credentials",
    );
  }
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/embeddings`;
  return endpoint.toString();
}

function memoryIndexForConfig(config) {
  if (config.service.retrievalProfile !== QDRANT_RETRIEVAL_PROFILE) {
    return undefined;
  }
  const environment = dotenv(config.paths.embeddingEnv);
  const baseUrl = stringAt(
    environment.PICORER_EMBEDDING_BASE_URL,
    "PICORER_EMBEDDING_BASE_URL",
  );
  const model = environment.PICORER_EMBEDDING_MODEL?.trim() || "text-embedding-v4";
  const dimensions = embeddingInteger(
    environment,
    "PICORER_EMBEDDING_DIMENSIONS",
    1024,
  );
  const maxInputLength = embeddingInteger(
    environment,
    "PICORER_EMBEDDING_MAX_INPUT_LENGTH",
    2048,
  );
  const profile = JSON.stringify({
    provider: "openai-compatible",
    endpointFingerprint: sha256(embeddingEndpoint(baseUrl)),
    model,
    dimensions,
    similarity: "cosine",
    maxInputLength,
    inputFormat: "role-colon-content-v1",
    cleaning: "openai-special-token-cleaning-v1",
    chunkAggregation: "arithmetic-mean-v1",
  });
  return {
    retrievalProfile: QDRANT_RETRIEVAL_PROFILE,
    embeddingProfileId: `embedding-${sha256(profile).slice(0, 24)}`,
    embeddingModel: model,
    embeddingDimensions: dimensions,
    vectorGenerationId: config.service.qdrant.vectorGenerationId,
    vectorCollection: config.service.qdrant.collection,
    vectorSearch: {
      algorithm: "qdrant-hnsw",
      hnswM: config.service.qdrant.hnswM,
      efConstruct: config.service.qdrant.efConstruct,
      hnswEf: config.service.qdrant.hnswEf,
      fullScanThresholdKb: config.service.qdrant.fullScanThresholdKb,
      indexingThresholdKb: config.service.qdrant.indexingThresholdKb,
      exact: false,
      requestTimeoutMs: config.service.qdrant.requestTimeoutMs,
      fallbackPolicy: "sqlite-exact-on-unavailable-v1",
    },
  };
}

export function runtimeIdentityForConfig(config) {
  const path = skillFile(config);
  const memoryIndex = memoryIndexForConfig(config);
  const contract = {
    schema_version: 1,
    source_identity: config.service.sourceIdentity,
    build_identity: config.service.buildIdentity,
    skill: {
      id: config.service.skill,
      sha256: sha256(path === null ? "" : readFileSync(path, "utf8")),
    },
    agent_interface: config.service.interfaceMode,
    ...(config.service.requireWorkingMemory ? { working_memory_requirement: "required-after-observation-v1" } : {}),
    retrieval: {
      provider_id: "picorer-openai",
      logical_model_id: config.models.retrieval.id,
      route_model_id: config.models.retrieval.routeId,
      protocol: config.models.retrieval.protocol,
      thinking_level: config.models.retrieval.thinkingLevel,
      transport: "non-stream",
      base_url: config.credentials.generation.baseUrl,
    },
    ...(memoryIndex === undefined ? {} : { memory_index: memoryIndex }),
    limits: {
      max_run_ms: config.service.maxRunMs,
      max_turns: config.service.maxTurns,
      max_tool_calls: config.service.maxToolCalls,
      max_search_calls: config.run.maxSearchCalls,
      request_timeout_ms: config.service.requestTimeoutMs,
      request_max_retries: 1,
      request_max_retry_delay_ms: 5_000,
      max_concurrent_wraps: config.service.maxConcurrentWraps,
    },
    answer_handoff: {
      id: ANSWER_HANDOFF_ID,
      prompt_version: ANSWER_PROMPT_VERSION,
    },
  };
  return { contract, sha256: sha256(canonical(contract)) };
}

export function runConfigIdentity(config, task, mode) {
  return sha256(canonical({
    schema_version: 1,
    task,
    mode,
    runtime_identity_sha256: runtimeIdentityForConfig(config).sha256,
    memory_base_url: `http://${config.service.host}:${String(config.service.port)}`,
    answer_base_url: config.credentials.generation.baseUrl,
    generation_ca_sha256: config.credentials.generation.caBundle === null
      ? null
      : sha256(readFileSync(config.credentials.generation.caBundle, "utf8")),
    answer_model: config.models.answer,
    max_contexts: config.run.maxContexts,
    max_queries: config.run.maxQueries,
    context_slots: config.run.contextSlots,
    query_slots: config.run.querySlots,
    adaptive_query_slots: config.run.adaptiveQuerySlots,
    answer_timeout_seconds: config.run.answerTimeoutSeconds,
    memory_timeout_seconds: config.run.memoryTimeoutSeconds,
    reuse_ingestion_from: config.run.reuseIngestionFrom[task] ?? null,
  }));
}

function dotenv(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/u);
    if (!match) throw new Error(`Invalid environment line in ${path}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function writeAgentConfig(config) {
  const directory = join(config.paths.runtimeDir, "agent-config");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const provider = "picorer-openai";
  const model = config.models.retrieval;
  const models = {
    providers: {
      [provider]: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens",
          supportsStrictMode: false,
        },
        models: [{
          id: model.routeId,
          name: model.id,
          reasoning: true,
          input: ["text"],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  writeFileSync(join(directory, "models.json"), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(directory, "settings.json"), `${JSON.stringify({
    defaultProvider: provider,
    defaultModel: model.routeId,
    defaultThinkingLevel: model.thinkingLevel,
  }, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

export function serviceEnvironment(config, inherited = process.env) {
  const runtimeIdentity = runtimeIdentityForConfig(config);
  const qdrant = config.service.qdrant;
  const environment = {
    ...inherited,
    ...dotenv(config.paths.embeddingEnv),
    OPENAI_API_KEY: config.credentials.generation.apiKey,
    OPENAI_API_BASE: config.credentials.generation.baseUrl,
    PICORER_AGENT_DIR: writeAgentConfig(config),
    PICORER_DATA_DIR: join(config.paths.runtimeDir, "memory-service"),
    PICORER_PROVIDER: "picorer-openai",
    PICORER_MODEL: config.models.retrieval.routeId,
    PICORER_LOGICAL_MODEL_ID: config.models.retrieval.id,
    PICORER_RETRIEVAL_PROTOCOL: config.models.retrieval.protocol,
    PICORER_RETRIEVAL_PROFILE: config.service.retrievalProfile,
    PICORER_THINKING_LEVEL: config.models.retrieval.thinkingLevel,
    PICORER_TRANSPORT: "non-stream",
    PICORER_MAX_RUN_MS: String(config.service.maxRunMs),
    PICORER_MAX_TURNS: String(config.service.maxTurns),
    PICORER_MAX_TOOL_CALLS: String(config.service.maxToolCalls),
    PICORER_MAX_SEARCH_CALLS: String(config.run.maxSearchCalls),
    PICORER_MAX_CONCURRENT_WRAPS: String(config.service.maxConcurrentWraps),
    PICORER_REQUEST_TIMEOUT_MS: String(config.service.requestTimeoutMs),
    PICORER_SKILL: config.service.skill,
    PICORER_INTERFACE_MODE: config.service.interfaceMode,
    PICORER_REQUIRE_WORKING_MEMORY: String(config.service.requireWorkingMemory),
    PICORER_SOURCE_IDENTITY: config.service.sourceIdentity,
    PICORER_BUILD_IDENTITY: config.service.buildIdentity,
    PICORER_EXPECTED_RUNTIME_IDENTITY_SHA256: runtimeIdentity.sha256,
    ...(qdrant === null
      ? {}
      : {
          PICORER_QDRANT_URL: qdrant.url,
          PICORER_QDRANT_COLLECTION: qdrant.collection,
          PICORER_VECTOR_GENERATION_ID: qdrant.vectorGenerationId,
          PICORER_QDRANT_TIMEOUT_MS: String(qdrant.requestTimeoutMs),
          PICORER_QDRANT_HNSW_M: String(qdrant.hnswM),
          PICORER_QDRANT_EF_CONSTRUCT: String(qdrant.efConstruct),
          PICORER_QDRANT_HNSW_EF: String(qdrant.hnswEf),
          PICORER_QDRANT_FULL_SCAN_THRESHOLD_KB: String(
            qdrant.fullScanThresholdKb,
          ),
          PICORER_QDRANT_INDEXING_THRESHOLD_KB: String(
            qdrant.indexingThresholdKb,
          ),
          PICORER_QDRANT_SYNC_BATCH_SIZE: String(qdrant.syncBatchSize),
          PICORER_QDRANT_SYNC_CONCURRENCY: String(qdrant.syncConcurrency),
          PICORER_QDRANT_VERIFY_POLL_MS: String(qdrant.verificationPollMs),
          PICORER_QDRANT_VERIFY_TIMEOUT_MS: String(
            qdrant.verificationTimeoutMs,
          ),
          ...(qdrant.apiKey === undefined
            ? {}
            : { PICORER_QDRANT_API_KEY: qdrant.apiKey }),
        }),
    HOST: config.service.host,
    PORT: String(config.service.port),
  };
  const caBundle = config.credentials.generation.caBundle;
  if (caBundle === null) {
    delete environment.NODE_EXTRA_CA_CERTS;
    delete environment.SSL_CERT_FILE;
    delete environment.REQUESTS_CA_BUNDLE;
  } else {
    environment.NODE_EXTRA_CA_CERTS = caBundle;
    environment.SSL_CERT_FILE = caBundle;
    environment.REQUESTS_CA_BUNDLE = caBundle;
  }
  if (qdrant !== null && qdrant.apiKey === undefined) {
    delete environment.PICORER_QDRANT_API_KEY;
  }
  return environment;
}

export function runnerInvocation(
  config,
  mode,
  outputPath,
  task = config.run.tasks[0],
  resume = false,
) {
  if (!config.run.modes.includes(mode)) throw new Error(`Mode is not enabled: ${mode}`);
  if (!config.run.tasks.includes(task)) throw new Error(`Task is not enabled: ${task}`);
  const output = outputPath ?? join(
    config.paths.outputDir,
    config.run.label,
    `${task}-${mode}.json`,
  );
  const optionalLimits = [
    ...(config.run.maxContexts === null
      ? []
      : ["--max-contexts", String(config.run.maxContexts)]),
    ...(config.run.maxQueries === null
      ? []
      : ["--max-queries", String(config.run.maxQueries)]),
  ];
  const reuseIngestionFrom = config.run.reuseIngestionFrom[task];
  const environment = {
    ...process.env,
    OPENAI_API_KEY: config.credentials.generation.apiKey,
    NLTK_DATA: config.paths.nltkData,
  };
  const caBundle = config.credentials.generation.caBundle;
  if (caBundle === null) {
    delete environment.NODE_EXTRA_CA_CERTS;
    delete environment.SSL_CERT_FILE;
    delete environment.REQUESTS_CA_BUNDLE;
  } else {
    environment.NODE_EXTRA_CA_CERTS = caBundle;
    environment.SSL_CERT_FILE = caBundle;
    environment.REQUESTS_CA_BUNDLE = caBundle;
  }
  return {
    command: config.paths.uv,
    cwd: join(config.paths.source, "integrations", "memoryagentbench"),
    env: environment,
    args: [
      "run", "--with-requirements", "requirements.txt", "python", "run.py", "run",
      "--task", task,
      "--data-dir", config.paths.dataDir,
      "--output", output,
      "--memory-base-url", `http://${config.service.host}:${String(config.service.port)}`,
      "--memory-timeout-seconds", String(config.run.memoryTimeoutSeconds),
      "--answer-base-url", config.credentials.generation.baseUrl,
      "--answer-model", config.models.answer.id,
      "--answer-thinking-level", config.models.answer.thinkingLevel,
      "--answer-max-tokens", String(config.models.answer.maxTokens),
      "--answer-context-window", String(config.models.answer.contextWindow),
      "--answer-context-safety-tokens",
      String(config.models.answer.contextSafetyTokens),
      "--answer-timeout-seconds", String(config.run.answerTimeoutSeconds),
      "--operator-mode", mode,
      "--max-search-calls", String(config.run.maxSearchCalls),
      "--context-slots", String(config.run.contextSlots),
      "--query-slots", String(config.run.querySlots),
      "--run-config-sha256", runConfigIdentity(config, task, mode),
      ...adaptiveRunnerArguments(config.run.adaptiveQuerySlots),
      ...(reuseIngestionFrom === undefined
        ? []
        : ["--reuse-ingestion-from", reuseIngestionFrom]),
      ...optionalLimits,
      ...(resume ? ["--resume"] : []),
    ],
    output,
  };
}

function sanitized(config) {
  return {
    config: config.configPath,
    retrieval_model: config.models.retrieval.id,
    retrieval_route: config.models.retrieval.routeId,
    answer_model: config.models.answer.id,
    endpoint: config.credentials.generation.baseUrl,
    generation_ca_sha256: config.credentials.generation.caBundle === null
      ? null
      : sha256(readFileSync(config.credentials.generation.caBundle, "utf8")),
    port: config.service.port,
    tasks: config.run.tasks,
    modes: config.run.modes,
    max_search_calls: config.run.maxSearchCalls,
    max_concurrent_wraps: config.service.maxConcurrentWraps,
    retrieval_request_timeout_ms: config.service.requestTimeoutMs,
    answer_timeout_seconds: config.run.answerTimeoutSeconds,
    memory_timeout_seconds: config.run.memoryTimeoutSeconds,
    retrieval_skill: config.service.skill,
    agent_interface: config.service.interfaceMode,
    ...(config.service.requireWorkingMemory ? { working_memory_requirement: "required-after-observation-v1" } : {}),
    context_slots: config.run.contextSlots,
    query_slots: config.run.querySlots,
    adaptive_query_slots: config.run.adaptiveQuerySlots,
    source_identity: config.service.sourceIdentity,
    build_identity: config.service.buildIdentity,
    retrieval_profile: config.service.retrievalProfile,
    vector_generation_id: config.service.qdrant?.vectorGenerationId ?? null,
    runtime_identity_sha256: runtimeIdentityForConfig(config).sha256,
    reuse_ingestion_from: config.run.reuseIngestionFrom,
    credentials: "configured",
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function suiteStatePath(config) {
  return join(config.paths.outputDir, config.run.label, "suite-state.json");
}

export function artifactStatus(config, task, mode) {
  const output = join(config.paths.outputDir, config.run.label, `${task}-${mode}.json`);
  if (!existsSync(output)) return { task, mode, status: "pending", output };
  try {
    const document = JSON.parse(readFileSync(output, "utf8"));
    if (document.task !== task) throw new Error("artifact task does not match");
    if (document.operator_experiment?.mode !== mode) {
      throw new Error("artifact operator mode does not match");
    }
    if (document.answer_model !== config.models.answer.id) {
      throw new Error("artifact answer model does not match");
    }
    if (document.memory_base_url !==
      `http://${config.service.host}:${String(config.service.port)}`) {
      throw new Error("artifact memory endpoint does not match");
    }
    if (document.run_config_sha256 !== runConfigIdentity(config, task, mode)) {
      throw new Error("artifact run config identity does not match");
    }
    const expectedRuntime = runtimeIdentityForConfig(config);
    if (document.retrieval_runtime_identity_sha256 !== expectedRuntime.sha256) {
      throw new Error("artifact retrieval runtime identity does not match");
    }
    if (canonical(document.retrieval_runtime_contract) !==
      canonical(expectedRuntime.contract)) {
      throw new Error("artifact retrieval runtime contract does not match");
    }
    if (typeof document.memory_persistence_identity !== "string" ||
      !document.memory_persistence_identity.trim()) {
      throw new Error("artifact memory persistence identity is missing");
    }
    if (!Array.isArray(document.data) || !Array.isArray(document.expected_query_ids)) {
      throw new Error("artifact query data is incomplete");
    }
    const expectedIds = document.expected_query_ids;
    if (expectedIds.some((id) => typeof id !== "string") ||
      new Set(expectedIds).size !== expectedIds.length) {
      throw new Error("artifact expected query IDs are invalid");
    }
    const configuredExpected = config.run.maxQueries === null
      ? (config.run.maxContexts === null ? TASK_QUESTION_COUNTS[task] : null)
      : Math.min(config.run.maxQueries, TASK_QUESTION_COUNTS[task]);
    if (configuredExpected !== null && expectedIds.length !== configuredExpected) {
      throw new Error("artifact expected query count does not match config");
    }
    const completedIds = document.data.map((row) => row?.benchmark_query_id);
    if (completedIds.some((id) => typeof id !== "string") ||
      new Set(completedIds).size !== completedIds.length ||
      completedIds.some((id) => !expectedIds.includes(id))) {
      throw new Error("artifact completed query IDs are invalid");
    }
    if (document.completed_queries !== document.data.length) {
      throw new Error("artifact completed_queries does not match data length");
    }
    const completed = document.data.length;
    return {
      task,
      mode,
      status: completed === expectedIds.length
        ? "completed"
        : "partial",
      completed_queries: completed,
      expected_queries: expectedIds.length,
      failures: Array.isArray(document.failures) ? document.failures.length : 0,
      retryable_failures: Array.isArray(document.retryable_failures)
        ? document.retryable_failures.length
        : 0,
      official_score: document.metrics?.official_score ?? null,
      output,
    };
  } catch (error) {
    return { task, mode, status: "invalid", output, error: String(error) };
  }
}

function suiteStatus(config) {
  const jobs = config.run.tasks.flatMap((task) =>
    config.run.modes.map((mode) => artifactStatus(config, task, mode))
  );
  return {
    label: config.run.label,
    combinations: jobs.length,
    completed_combinations: jobs.filter((job) => job.status === "completed").length,
    completed_queries: jobs.reduce((total, job) => total + (job.completed_queries ?? 0), 0),
    expected_queries: jobs.reduce((total, job) => total + (job.expected_queries ?? TASK_QUESTION_COUNTS[job.task]), 0),
    jobs,
  };
}

function childOutcome(child) {
  return new Promise((resolveOutcome, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
}

async function runSuite(config) {
  const directory = join(config.paths.outputDir, config.run.label);
  const logs = join(directory, "logs");
  mkdirSync(logs, { recursive: true });
  const queue = config.run.tasks.flatMap((task) =>
    config.run.modes.map((mode) => ({ task, mode }))
  ).filter(({ task, mode }) => artifactStatus(config, task, mode).status !== "completed");
  const failed = [];
  let stopping = false;
  const children = new Set();
  const stop = () => {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const worker = async () => {
    while (!stopping && queue.length > 0) {
      const job = queue.shift();
      const status = artifactStatus(config, job.task, job.mode);
      if (status.status === "completed") continue;
      const invocation = runnerInvocation(config, job.mode, status.output, job.task, existsSync(status.output));
      const logPath = join(logs, `${job.task}-${job.mode}.log`);
      const log = openSync(logPath, "a", 0o600);
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["ignore", log, log],
      });
      children.add(child);
      const outcome = await childOutcome(child);
      children.delete(child);
      closeSync(log);
      writeJsonAtomic(suiteStatePath(config), suiteStatus(config));
      if (stopping) break;
      if (outcome.code === 75) {
        queue.push(job);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, config.run.retryDelaySeconds * 1000));
        continue;
      }
      const after = artifactStatus(config, job.task, job.mode);
      if (outcome.code !== 0 || after.status !== "completed") {
        failed.push({ ...job, outcome, artifact_status: after.status });
      }
    }
  };
  const workerCount = Math.min(config.run.slots, Math.max(queue.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const status = suiteStatus(config);
  writeJsonAtomic(suiteStatePath(config), { ...status, failed, stopping });
  process.stdout.write(`${JSON.stringify({ ...status, failed, stopping }, null, 2)}\n`);
  if (stopping) process.exitCode = 130;
  else if (failed.length > 0 || status.completed_combinations !== status.combinations) {
    process.exitCode = 1;
  }
}

async function spawnAndWait(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });
  const forwardTerm = () => child.kill("SIGTERM");
  const forwardInterrupt = () => child.kill("SIGINT");
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInterrupt);
  let outcome;
  try {
    outcome = await childOutcome(child);
  } finally {
    process.off("SIGTERM", forwardTerm);
    process.off("SIGINT", forwardInterrupt);
  }
  if (outcome.signal !== null) process.kill(process.pid, outcome.signal);
  else process.exitCode = outcome.code ?? 1;
}

async function main() {
  const [command, configPath, mode, outputPath] = process.argv.slice(2);
  if (!command || !configPath) {
    throw new Error("Usage: run_from_yaml.mjs --check|service|run|suite|status CONFIG.yaml [MODE] [OUTPUT]");
  }
  const config = loadMemoryAgentBenchYaml(configPath);
  if (command === "--check") {
    process.stdout.write(`${JSON.stringify(sanitized(config), null, 2)}\n`);
    return;
  }
  if (command === "service") {
    await spawnAndWait(
      config.paths.node,
      ["--disable-warning=ExperimentalWarning", join(config.paths.source, "dist", "memoryarena-public-api.js")],
      { env: serviceEnvironment(config) },
    );
    return;
  }
  if (command === "run") {
    if (!mode) throw new Error("run requires a configured mode");
    const invocation = runnerInvocation(config, mode, outputPath);
    mkdirSync(dirname(invocation.output), { recursive: true });
    await spawnAndWait(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
    });
    return;
  }
  if (command === "suite") {
    await runSuite(config);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(suiteStatus(config), null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
