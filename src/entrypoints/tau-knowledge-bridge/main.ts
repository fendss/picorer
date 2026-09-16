import { createInterface } from "node:readline";
import {
  DEFAULT_INTERACTIVE_MEMORY_MAX_TOOL_CALLS_PER_INPUT,
  DEFAULT_INTERACTIVE_MEMORY_MAX_TURNS_PER_INPUT,
  InteractiveMemoryAgentSession,
  PICORER_ACTION_SKILL_HASH,
  PICORER_ACTION_SKILL_VERSION,
  PICORER_INTERACTIVE_HARNESS_VERSION,
  type ExternalToolDefinition,
  type InteractiveAgentInput,
  type InteractiveMemorySkill,
} from "../../agent-runtime/index.js";
import {
  TAU_KNOWLEDGE_IDENTITY,
  tauKnowledgeDataPaths,
} from "../../benchmark/tau-knowledge/index.js";
import { createSelectedSearchOperatorRegistry } from "../../composition/create-search-operator-registry.js";
import { createReadOnlyScopeNavigation } from "../../composition/create-read-only-navigation.js";
import { loadSearchOperatorPlugins } from "../../composition/load-search-operator-plugins.js";
import { createRetrievalContext } from "../../composition/create-retrieval-context.js";
import { loadPiModelRuntime } from "../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../platform/sqlite/picorer-store.js";
import type { RetrievalProfile } from "../../retrieval/index.js";
import { sha256 } from "../../util.js";
import {
  assertOnlyFlags,
  MODEL_RUNTIME_FLAG_NAMES,
  modelOptionsFor,
  optionalFlag,
  parseCommand,
  positiveIntegerFlag,
  requiredFlag,
} from "../cli/parse-command.js";
import { readJsonFileIfPresent } from "../cli/workflow-files.js";

interface TauKnowledgeManifest {
  schema_version: 1;
  benchmark: "tau-knowledge";
  source: typeof TAU_KNOWLEDGE_IDENTITY;
  scope_id: string;
  document_count: number;
  task_count: number;
  corpus_hash: string;
  task_set_hash: string;
  retrieval: {
    retrievalProfile: RetrievalProfile;
    embeddingProfileId?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
}

interface InitializeRequest {
  type: "initialize";
  domainPolicy: string;
  tools: ExternalToolDefinition[];
  initialAssistantMessage: string;
}

const MODEL_FLAGS = MODEL_RUNTIME_FLAG_NAMES;

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function initializeRequest(value: unknown): InitializeRequest {
  const request = objectAt(value, "initialize request");
  if (request["type"] !== "initialize") {
    throw new TypeError("First bridge request must be initialize");
  }
  if (
    typeof request["domainPolicy"] !== "string" ||
    request["domainPolicy"].trim().length === 0
  ) {
    throw new TypeError("initialize.domainPolicy must be non-empty");
  }
  if (!Array.isArray(request["tools"])) {
    throw new TypeError("initialize.tools must be an array");
  }
  if (
    typeof request["initialAssistantMessage"] !== "string" ||
    request["initialAssistantMessage"].trim().length === 0
  ) {
    throw new TypeError("initialize.initialAssistantMessage must be non-empty");
  }
  const tools = request["tools"].map((raw, index) => {
    const tool = objectAt(raw, `initialize.tools[${index}]`);
    const parameters = objectAt(
      tool["parameters"],
      `initialize.tools[${index}].parameters`,
    );
    if (
      typeof tool["name"] !== "string" ||
      typeof tool["description"] !== "string"
    ) {
      throw new TypeError(`initialize.tools[${index}] is invalid`);
    }
    return {
      name: tool["name"],
      description: tool["description"],
      parameters,
    };
  });
  return {
    type: "initialize",
    domainPolicy: request["domainPolicy"],
    tools,
    initialAssistantMessage: request["initialAssistantMessage"],
  };
}

function agentInput(value: unknown): InteractiveAgentInput {
  const input = objectAt(value, "agent input");
  if (input["type"] === "user") {
    if (typeof input["content"] !== "string") {
      throw new TypeError("user.content must be a string");
    }
    return { type: "user", content: input["content"] };
  }
  if (input["type"] !== "tool-results" || !Array.isArray(input["results"])) {
    throw new TypeError("agent input must be user or tool-results");
  }
  return {
    type: "tool-results",
    results: input["results"].map((raw, index) => {
      const result = objectAt(raw, `tool-results.results[${index}]`);
      if (
        typeof result["toolCallId"] !== "string" ||
        typeof result["toolName"] !== "string" ||
        typeof result["content"] !== "string" ||
        typeof result["isError"] !== "boolean"
      ) {
        throw new TypeError(`tool-results.results[${index}] is invalid`);
      }
      return {
        toolCallId: result["toolCallId"],
        toolName: result["toolName"],
        content: result["content"],
        isError: result["isError"],
      };
    }),
  };
}

function skillForBridge(raw: string | undefined): InteractiveMemorySkill {
  const skill = raw ?? "picorer-v0";
  if (skill !== "none" && skill !== "picorer-v0") {
    throw new Error(`Unknown interactive Picorer skill: ${skill}`);
  }
  return skill;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const parsed = parseCommand(["tau-knowledge-bridge", ...process.argv.slice(2)]);
  assertOnlyFlags(parsed, [
    "data-dir",
    "skill",
    "operator",
    "operator-module",
    "max-turns-per-input",
    "max-tool-calls-per-input",
    "max-input-ms",
    ...MODEL_FLAGS,
  ]);
  const paths = tauKnowledgeDataPaths(requiredFlag(parsed, "data-dir"));
  const manifest = await readJsonFileIfPresent<TauKnowledgeManifest>(
    paths.manifest,
  );
  if (
    manifest === undefined || manifest.schema_version !== 1 ||
    manifest.benchmark !== "tau-knowledge" ||
    manifest.source.upstreamRevision !== TAU_KNOWLEDGE_IDENTITY.upstreamRevision ||
    manifest.source.documentsSha256 !== TAU_KNOWLEDGE_IDENTITY.documentsSha256 ||
    manifest.source.tasksSha256 !== TAU_KNOWLEDGE_IDENTITY.tasksSha256 ||
    manifest.document_count !== TAU_KNOWLEDGE_IDENTITY.documentCount ||
    manifest.task_count !== TAU_KNOWLEDGE_IDENTITY.taskCount
  ) {
    throw new Error("Missing or incompatible tau-Knowledge data manifest");
  }
  const skill = skillForBridge(optionalFlag(parsed, "skill"));
  const selectedOperators = parsed.flags.get("operator") ?? [
    "hybrid",
    "lexical",
    "chronological",
    "temporal-index",
    "numeric-index",
  ];
  const rawStore = await MemoryStore.create(paths.database);
  try {
    const modelRuntime = await loadPiModelRuntime(modelOptionsFor(parsed));
    const retrievalContext = createRetrievalContext(
      rawStore,
      manifest.retrieval.retrievalProfile,
    );
    if (
      JSON.stringify(retrievalContext.metadata) !==
        JSON.stringify(manifest.retrieval)
    ) {
      throw new Error("tau-Knowledge runtime retrieval identity mismatch");
    }
    const plugins = await loadSearchOperatorPlugins(
      parsed.flags.get("operator-module") ?? [],
      retrievalContext.store,
    );
    const operatorRegistry = createSelectedSearchOperatorRegistry(
      retrievalContext.store,
      selectedOperators,
      plugins.operators,
    );
    let session: InteractiveMemoryAgentSession | undefined;
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (session === undefined) {
          const request = initializeRequest(value);
          session = new InteractiveMemoryAgentSession({
            store: retrievalContext.store,
            operatorRegistry,
            modelRuntime,
            scopeId: manifest.scope_id,
            readOnlyNavigation: createReadOnlyScopeNavigation(
              paths.sanitized,
              manifest.scope_id,
            ),
            domainPolicy: request.domainPolicy,
            externalTools: request.tools,
            initialAssistantMessage: request.initialAssistantMessage,
            skill,
            maxTurnsPerInput: positiveIntegerFlag(
              parsed,
              "max-turns-per-input",
              DEFAULT_INTERACTIVE_MEMORY_MAX_TURNS_PER_INPUT,
              128,
            ),
            maxToolCallsPerInput: positiveIntegerFlag(
              parsed,
              "max-tool-calls-per-input",
              DEFAULT_INTERACTIVE_MEMORY_MAX_TOOL_CALLS_PER_INPUT,
              256,
            ),
            maxInputMs: positiveIntegerFlag(
              parsed,
              "max-input-ms",
              300_000,
              1_800_000,
            ),
          });
          const operatorCatalog = operatorRegistry.list();
          output({
            type: "ready",
            protocol_version: 1,
            session_id: session.sessionId,
            benchmark: "tau-knowledge",
            source_revision: manifest.source.upstreamRevision,
            corpus_hash: manifest.corpus_hash,
            retrieval: manifest.retrieval,
            model: {
              providerId: modelRuntime.providerId,
              modelId: modelRuntime.modelId,
              thinkingLevel: modelRuntime.thinkingLevel,
              transport: modelRuntime.transport,
            },
            harness: PICORER_INTERACTIVE_HARNESS_VERSION,
            skill: {
              mode: skill,
              version: skill === "none" ? null : PICORER_ACTION_SKILL_VERSION,
              hash: skill === "none" ? null : PICORER_ACTION_SKILL_HASH,
            },
            operators: operatorCatalog,
            operator_catalog_hash: sha256(JSON.stringify(operatorCatalog)),
            operator_plugins: plugins.modules,
          });
          continue;
        }
        output({ type: "assistant", ...(await session.turn(agentInput(value))) });
      } catch (error) {
        output({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    rawStore.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Picorer tau-Knowledge bridge error: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
