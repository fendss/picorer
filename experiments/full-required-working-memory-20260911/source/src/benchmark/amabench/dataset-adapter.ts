import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MemorySessionInput, MemoryTurnInput } from "../../memory/index.js";
import type { BenchmarkQuery } from "../model/benchmark-query.js";
import { sha256 } from "../../util.js";

/**
 * Byte-exact identity of the public AMA-Bench real-world open-ended test set.
 *
 * The dataset is deliberately pinned independently from the upstream runner:
 * the Git repository defines the Build/Retrieve/evaluation contract, while the
 * Hugging Face repository owns the data bytes.
 */
export const AMA_BENCH_V4_IDENTITY = Object.freeze({
  datasetId: "AMA-bench/AMA-bench",
  datasetRevision: "a5777378066f53229a94557a7b192435cd027909",
  relativePath: "test/open_end_qa_set.jsonl",
  sha256: "45c36052e1520d87ad9de4114f71c9df42d4aac9cf158c0c353e800b653d65ff",
  upstreamCodeRevision: "ddfd319e0be33424288c13806f1eafc63e625b59",
  paperRevision: "arXiv:2602.22769v4",
  episodeCount: 208,
  questionCount: 2_496,
} as const);

export const AMA_BENCH_V4_DOMAINS = [
  "EMBODIED_AI",
  "Game",
  "OPENWORLD_QA",
  "SOFTWARE",
  "TEXT2SQL",
  "WEB",
] as const;

export const AMA_BENCH_V4_TASK_TYPES = [
  "2048",
  "alfworld",
  "babaisai",
  "candy_crush",
  "crafter",
  "gaia_level1",
  "gaia_level2",
  "gaia_level3",
  "minihack",
  "spider2",
  "swebench",
  "webarena",
] as const;

export type AmaBenchDomain = (typeof AMA_BENCH_V4_DOMAINS)[number];
export type AmaBenchTaskType = (typeof AMA_BENCH_V4_TASK_TYPES)[number];
export type AmaBenchCapability = "A" | "B" | "C" | "D";

/** Query-visible data. It intentionally contains no answer or capability. */
export interface AmaBenchPrivateQuery extends BenchmarkQuery {
  episodeId: number;
  questionIndex: number;
}

/** Judge-only data. This object must never be passed to retrieval or answer. */
export interface AmaBenchPrivateLabel {
  scopeId: string;
  episodeId: number;
  questionId: string;
  questionIndex: number;
  referenceAnswer: string;
  capability: AmaBenchCapability;
  taskDescription: string;
  taskType: AmaBenchTaskType;
  domain: AmaBenchDomain;
}

export interface AmaBenchAdapterResult {
  /** The only adapter output authorized to cross the ingest boundary. */
  memorySessions: MemorySessionInput[];
  /** Loaded only when a retrieval run is about to start. */
  privateQueries: AmaBenchPrivateQuery[];
  /** Loaded only after frozen predictions exist and judging begins. */
  privateLabels: AmaBenchPrivateLabel[];
}

type JsonObject = Record<string, unknown>;

const DATASET_NAMESPACE = "ama-bench-real-world-openend-v4";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOMAINS = new Set<string>(AMA_BENCH_V4_DOMAINS);
const TASK_TYPES = new Set<string>(AMA_BENCH_V4_TASK_TYPES);
const CAPABILITIES = new Set<string>(["A", "B", "C", "D"]);

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value;
}

function sourceTextAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableSourceTextAt(
  value: unknown,
  path: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string or null`);
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
  }
  return value;
}

function memberAt<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): T {
  const normalized = sourceTextAt(value, path).trim();
  if (!allowed.has(normalized)) {
    throw new TypeError(`${path} has unsupported value ${JSON.stringify(normalized)}`);
  }
  return normalized as T;
}

function questionUuidAt(value: unknown, path: string): string {
  const uuid = sourceTextAt(value, path).trim();
  if (!UUID.test(uuid)) {
    throw new TypeError(`${path} must be a canonical UUID`);
  }
  return uuid.toLowerCase();
}

export function amaBenchScopeId(episodeId: number): string {
  const normalized = nonNegativeIntegerAt(episodeId, "episodeId");
  return `ama-v4-${sha256(`${DATASET_NAMESPACE}\0${normalized}`).slice(0, 16)}`;
}

export function amaBenchSessionId(scopeId: string): string {
  const normalized = sourceTextAt(scopeId, "scopeId").trim();
  return `s-${sha256(`${normalized}\0trajectory`).slice(0, 16)}`;
}

export function amaBenchMemoryId(
  scopeId: string,
  sourceCoordinate: "task" | `step:${number}`,
): string {
  const scope = sourceTextAt(scopeId, "scopeId").trim();
  const coordinate = sourceTextAt(sourceCoordinate, "sourceCoordinate").trim();
  return `m-${sha256(`${scope}\0${coordinate}`).slice(0, 24)}`;
}

/** Mirrors the official runner's trajectory text without normalizing payloads. */
export function renderAmaBenchStep(options: {
  turnIndex: number;
  action: string | null;
  observation: string | null;
}): string {
  const turnIndex = nonNegativeIntegerAt(options.turnIndex, "turnIndex");
  const action = options.action === null ? "None" : options.action;
  const observation = options.observation === null ? "None" : options.observation;
  return [
    `Step ${turnIndex}:`,
    `Action: ${action}`,
    `Observation: ${observation}`,
  ].join("\n");
}

/**
 * Trusted input firewall for AMA-Bench v4.
 *
 * Only `task` and the whitelisted `(turn_idx, action, observation)` trajectory
 * fields enter memory. In particular, QA answers, A/B/C/D capability labels,
 * domain/task labels, success, and all unknown source fields are reconstructed
 * into separate objects or discarded; raw source objects are never spread.
 */
export function adaptAmaBenchV4(raw: unknown): AmaBenchAdapterResult {
  const records = arrayAt(raw, "dataset");
  const memorySessions: MemorySessionInput[] = [];
  const privateQueries: AmaBenchPrivateQuery[] = [];
  const privateLabels: AmaBenchPrivateLabel[] = [];
  const seenEpisodes = new Set<number>();
  const seenQuestions = new Set<string>();
  const seenScopes = new Set<string>();

  records.forEach((rawRecord, recordIndex) => {
    const recordPath = `dataset[${recordIndex}]`;
    const record = objectAt(rawRecord, recordPath);
    const episodeId = nonNegativeIntegerAt(
      record["episode_id"],
      `${recordPath}.episode_id`,
    );
    if (seenEpisodes.has(episodeId)) {
      throw new Error(`Duplicate AMA-Bench episode_id: ${episodeId}`);
    }
    seenEpisodes.add(episodeId);

    const scopeId = amaBenchScopeId(episodeId);
    if (seenScopes.has(scopeId)) {
      throw new Error(`Opaque AMA-Bench scope collision: ${scopeId}`);
    }
    seenScopes.add(scopeId);

    const taskDescription = sourceTextAt(
      record["task"],
      `${recordPath}.task`,
    );
    const taskType = memberAt<AmaBenchTaskType>(
      record["task_type"],
      TASK_TYPES,
      `${recordPath}.task_type`,
    );
    const domain = memberAt<AmaBenchDomain>(
      record["domain"],
      DOMAINS,
      `${recordPath}.domain`,
    );
    // Validate official v4 envelope fields, but never copy them into memory.
    booleanAt(record["success"], `${recordPath}.success`);
    nonNegativeIntegerAt(record["total_tokens"], `${recordPath}.total_tokens`);

    const rawTrajectory = arrayAt(
      record["trajectory"],
      `${recordPath}.trajectory`,
    );
    if (rawTrajectory.length === 0) {
      throw new TypeError(`${recordPath}.trajectory must not be empty`);
    }
    const declaredTurns = nonNegativeIntegerAt(
      record["num_turns"],
      `${recordPath}.num_turns`,
    );
    if (declaredTurns !== rawTrajectory.length) {
      throw new TypeError(
        `${recordPath}.num_turns does not match trajectory length`,
      );
    }

    const turns: MemoryTurnInput[] = [{
      id: amaBenchMemoryId(scopeId, "task"),
      role: "system",
      content: `Task:\n${taskDescription}`,
      metadata: { sourceKind: "task" },
    }];
    const seenTurnIndices = new Set<number>();
    rawTrajectory.forEach((rawStep, stepIndex) => {
      const stepPath = `${recordPath}.trajectory[${stepIndex}]`;
      const step = objectAt(rawStep, stepPath);
      const turnIndex = nonNegativeIntegerAt(
        step["turn_idx"],
        `${stepPath}.turn_idx`,
      );
      if (seenTurnIndices.has(turnIndex)) {
        throw new Error(
          `Duplicate AMA-Bench turn_idx ${turnIndex} in episode ${episodeId}`,
        );
      }
      seenTurnIndices.add(turnIndex);
      const action = nullableSourceTextAt(
        step["action"],
        `${stepPath}.action`,
      );
      const observation = nullableSourceTextAt(
        step["observation"],
        `${stepPath}.observation`,
      );
      turns.push({
        id: amaBenchMemoryId(scopeId, `step:${turnIndex}`),
        role: "other",
        content: renderAmaBenchStep({ turnIndex, action, observation }),
        metadata: {
          sourceKind: "trajectory-step",
          sourceTurnIndex: turnIndex,
        },
      });
    });

    memorySessions.push({
      scopeId,
      sessionId: amaBenchSessionId(scopeId),
      turns,
      metadata: {
        datasetId: AMA_BENCH_V4_IDENTITY.datasetId,
        datasetRevision: AMA_BENCH_V4_IDENTITY.datasetRevision,
        sourceEpisodeId: episodeId,
      },
    });

    const qaPairs = arrayAt(record["qa_pairs"], `${recordPath}.qa_pairs`);
    if (qaPairs.length === 0) {
      throw new TypeError(`${recordPath}.qa_pairs must not be empty`);
    }
    qaPairs.forEach((rawQa, questionIndex) => {
      const qaPath = `${recordPath}.qa_pairs[${questionIndex}]`;
      const qa = objectAt(rawQa, qaPath);
      const questionId = questionUuidAt(
        qa["question_uuid"],
        `${qaPath}.question_uuid`,
      );
      if (seenQuestions.has(questionId)) {
        throw new Error(`Duplicate AMA-Bench question_uuid: ${questionId}`);
      }
      seenQuestions.add(questionId);
      const question = sourceTextAt(qa["question"], `${qaPath}.question`);
      const referenceAnswer = sourceTextAt(
        qa["answer"],
        `${qaPath}.answer`,
      );
      const capability = memberAt<AmaBenchCapability>(
        qa["type"],
        CAPABILITIES,
        `${qaPath}.type`,
      );

      privateQueries.push({
        scopeId,
        episodeId,
        questionId,
        questionIndex,
        question,
      });
      privateLabels.push({
        scopeId,
        episodeId,
        questionId,
        questionIndex,
        referenceAnswer,
        capability,
        taskDescription,
        taskType,
        domain,
      });
    });
  });

  return { memorySessions, privateQueries, privateLabels };
}

export function parseAmaBenchV4Jsonl(serialized: string): unknown[] {
  const lines = serialized.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    throw new TypeError("AMA-Bench JSONL must contain at least one record");
  }
  return lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new TypeError(`AMA-Bench JSONL line ${index + 1} must not be blank`);
    }
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new TypeError(
        `AMA-Bench JSONL line ${index + 1} is invalid JSON`,
        { cause: error },
      );
    }
  });
}

/** Loads only the byte-exact official v4 test artifact. */
export async function loadPinnedAmaBenchV4File(
  path: string,
): Promise<AmaBenchAdapterResult> {
  const bytes = await readFile(path);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== AMA_BENCH_V4_IDENTITY.sha256) {
    throw new Error(
      `AMA-Bench dataset hash mismatch: expected ${AMA_BENCH_V4_IDENTITY.sha256}, got ${actualHash}`,
    );
  }
  const result = adaptAmaBenchV4(parseAmaBenchV4Jsonl(bytes.toString("utf8")));
  if (
    result.memorySessions.length !== AMA_BENCH_V4_IDENTITY.episodeCount ||
    result.privateQueries.length !== AMA_BENCH_V4_IDENTITY.questionCount ||
    result.privateLabels.length !== AMA_BENCH_V4_IDENTITY.questionCount
  ) {
    throw new Error("Pinned AMA-Bench v4 cardinality invariant failed");
  }
  return result;
}
