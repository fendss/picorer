import { createHash } from "node:crypto";
import {
  MEMORYARENA_ANSWER_HANDOFF_ID,
  MEMORYARENA_ANSWER_PROMPT_VERSION,
} from "../../benchmark/memoryarena-public/index.js";
import {
  PICORER_MINIMAL_SKILL_HASH,
  PICORER_SKILL_HASH,
  type PicorerInterfaceMode,
  type PicorerSkill,
} from "../../evidence-agent/index.js";
import type { PiModelRuntime } from "../../platform/pi/load-model-runtime.js";
import type { RetrievalMetadata } from "../../retrieval/index.js";

export interface MemoryArenaRuntimeContract {
  schema_version: 1;
  source_identity: string;
  build_identity: string;
  skill: {
    id: PicorerSkill;
    sha256: string;
  };
  agent_interface: PicorerInterfaceMode;
  working_memory_requirement?: "required-after-observation-v1";
  retrieval: {
    provider_id: string;
    logical_model_id: string;
    route_model_id: string;
    protocol: string;
    thinking_level: string;
    transport: string;
    base_url: string;
  };
  memory_index?: RetrievalMetadata;
  limits: {
    max_run_ms: number;
    max_turns: number;
    max_tool_calls: number;
    max_search_calls: number;
    request_timeout_ms: number;
    request_max_retries: number;
    request_max_retry_delay_ms: number;
    max_concurrent_wraps: number;
  };
  answer_handoff: {
    id: string;
    prompt_version: string;
  };
}

export interface MemoryArenaRuntimeIdentity {
  contract: MemoryArenaRuntimeContract;
  sha256: string;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function memoryArenaRuntimeContractHash(
  contract: MemoryArenaRuntimeContract,
): string {
  return createHash("sha256").update(canonical(contract), "utf8").digest("hex");
}

export function skillHash(skill: PicorerSkill): string {
  if (skill === "picorer-v0") return PICORER_SKILL_HASH;
  if (skill === "picorer-minimal") return PICORER_MINIMAL_SKILL_HASH;
  return createHash("sha256").update("", "utf8").digest("hex");
}

export function createMemoryArenaRuntimeIdentity(options: {
  sourceIdentity: string;
  buildIdentity: string;
  skill: PicorerSkill;
  interfaceMode: PicorerInterfaceMode;
  requireWorkingMemory?: boolean;
  modelRuntime: PiModelRuntime;
  logicalModelId: string;
  protocol: string;
  baseUrl: string;
  maxRunMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxSearchCalls: number;
  requestTimeoutMs: number;
  requestMaxRetries: number;
  requestMaxRetryDelayMs: number;
  maxConcurrentWraps: number;
  memoryIndex?: RetrievalMetadata;
}): MemoryArenaRuntimeIdentity {
  const contract: MemoryArenaRuntimeContract = {
    schema_version: 1,
    source_identity: nonEmpty(options.sourceIdentity, "PICORER_SOURCE_IDENTITY"),
    build_identity: nonEmpty(options.buildIdentity, "PICORER_BUILD_IDENTITY"),
    skill: {
      id: options.skill,
      sha256: skillHash(options.skill),
    },
    agent_interface: options.interfaceMode,
    ...(options.requireWorkingMemory ? { working_memory_requirement: "required-after-observation-v1" as const } : {}),
    retrieval: {
      provider_id: options.modelRuntime.providerId,
      logical_model_id: nonEmpty(
        options.logicalModelId,
        "PICORER_LOGICAL_MODEL_ID",
      ),
      route_model_id: options.modelRuntime.modelId,
      protocol: nonEmpty(options.protocol, "PICORER_RETRIEVAL_PROTOCOL"),
      thinking_level: options.modelRuntime.thinkingLevel,
      transport: options.modelRuntime.transport,
      base_url: nonEmpty(options.baseUrl, "retrieval base URL").replace(/\/+$/u, ""),
    },
    ...(options.memoryIndex === undefined
      ? {}
      : { memory_index: structuredClone(options.memoryIndex) }),
    limits: {
      max_run_ms: options.maxRunMs,
      max_turns: options.maxTurns,
      max_tool_calls: options.maxToolCalls,
      max_search_calls: options.maxSearchCalls,
      request_timeout_ms: options.requestTimeoutMs,
      request_max_retries: options.requestMaxRetries,
      request_max_retry_delay_ms: options.requestMaxRetryDelayMs,
      max_concurrent_wraps: options.maxConcurrentWraps,
    },
    answer_handoff: {
      id: MEMORYARENA_ANSWER_HANDOFF_ID,
      prompt_version: MEMORYARENA_ANSWER_PROMPT_VERSION,
    },
  };
  return { contract, sha256: memoryArenaRuntimeContractHash(contract) };
}
