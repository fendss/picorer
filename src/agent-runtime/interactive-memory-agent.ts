import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Agent,
  type AgentTool,
  type BeforeToolCallContext,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { Unsafe, type TSchema } from "typebox";
import {
  aggregateAssistantUsage,
  assistantMessageText,
  createEphemeralMemoryContext,
  createPicorerTools,
  lastAssistantMessage,
  MemoryLedger,
  type PicorerRuntimeStore,
  type ReadOnlyNavigationBinding,
} from "../evidence-agent/index.js";
import type { PiModelRuntime } from "../platform/pi/load-model-runtime.js";
import {
  renderSearchOperatorCatalog,
  type RuntimeSearchOperatorCatalog,
  type SearchOperatorCatalog,
  type SearchOperatorCatalogIdentity,
  type SearchOperatorDefinition,
  type SearchOperatorDefinitionSnapshot,
  type SearchOperatorRegistry,
} from "../retrieval/index.js";
import { newRunId, sha256 } from "../util.js";

export type InteractiveMemorySkill = "none" | "picorer-v0";

const ACTION_SKILL_PATH = fileURLToPath(
  new URL("../../.agents/skills/picorer-knowledge-action/SKILL.md", import.meta.url),
);

export const PICORER_ACTION_SKILL_TEXT = readFileSync(ACTION_SKILL_PATH, "utf8");
export const PICORER_ACTION_SKILL_VERSION = "picorer-knowledge-action-evidence-transaction-v6";
export const PICORER_ACTION_SKILL_HASH = sha256(PICORER_ACTION_SKILL_TEXT);
export const PICORER_INTERACTIVE_HARNESS_VERSION = "picorer-interactive-agent-v6";
export const DEFAULT_INTERACTIVE_MEMORY_MAX_TURNS_PER_INPUT = 64;
export const DEFAULT_INTERACTIVE_MEMORY_MAX_TOOL_CALLS_PER_INPUT = 128;

export interface ExternalToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ExternalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExternalToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type InteractiveAgentInput =
  | { type: "user"; content: string }
  | { type: "tool-results"; results: ExternalToolResult[] };

export interface InteractiveMemoryTraceEntry {
  step: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
  isError: boolean;
  details?: unknown;
}

export interface InteractiveAgentOutput {
  content: string | null;
  toolCalls: ExternalToolCall[];
  usage: Usage;
  model: {
    providerId: string;
    modelId: string;
    responseModel: string;
    thinkingLevel: string;
    transport: string;
  };
  audit: {
    sessionId: string;
    harnessVersion: string;
    skill: {
      mode: InteractiveMemorySkill;
      version: string | null;
      hash: string | null;
    };
    operatorCatalogHash: string;
    operatorCatalog: SearchOperatorCatalogIdentity;
    operatorDefinitions: SearchOperatorDefinitionSnapshot[];
    trace: InteractiveMemoryTraceEntry[];
    candidateCount: number;
    inspectedEvidenceCount: number;
  };
}

export interface InteractiveMemoryAgentOptions {
  store: PicorerRuntimeStore;
  operatorRegistry: SearchOperatorRegistry;
  modelRuntime: PiModelRuntime;
  scopeId: string;
  readOnlyNavigation?: ReadOnlyNavigationBinding;
  domainPolicy: string;
  externalTools: readonly ExternalToolDefinition[];
  initialAssistantMessage?: string;
  skill?: InteractiveMemorySkill;
  maxTurnsPerInput?: number;
  maxToolCallsPerInput?: number;
  maxInputMs?: number;
  operatorDefinitions?: readonly SearchOperatorDefinition[];
  maxOperatorDefinitions?: number;
}

const MEMORY_TOOL_NAMES = new Set([
  "search",
  "define_operator",
  "read",
  "bash_ro",
]);

function activeSkillPrompt(skill: InteractiveMemorySkill): string {
  return skill === "none"
    ? ""
    : `<active_skill name="picorer-knowledge-action" version="${PICORER_ACTION_SKILL_VERSION}">\n` +
      `${PICORER_ACTION_SKILL_TEXT}\n</active_skill>`;
}

export function interactiveMemorySystemPrompt(options: {
  domainPolicy: string;
  operatorRegistry: SearchOperatorCatalog;
  skill: InteractiveMemorySkill;
}): string {
  const catalog = renderSearchOperatorCatalog(options.operatorRegistry.list());
  return [
    "You are a knowledge-grounded interactive agent. Help the user complete the domain task while obeying the supplied domain policy.",
    "Memory operations are part of your reasoning loop: search locates candidate source documents, read verifies exact candidates without committing them, and optional bash_ro performs read-only navigation. Domain tools affect the external environment.",
    "Never issue memory operations and domain action tools in the same assistant tool-call batch. Search and read first, then issue domain tools in a later turn. Do not mention internal candidate handles, evidence handles, or memory IDs to the user.",
    `<domain_policy>\n${options.domainPolicy}\n</domain_policy>`,
    `<search_operator_catalog>\n${catalog}\n</search_operator_catalog>`,
    activeSkillPrompt(options.skill),
  ].filter(Boolean).join("\n\n");
}

function toolNames(context: BeforeToolCallContext): string[] {
  return context.assistantMessage.content
    .filter((block): block is Extract<
      AssistantMessage["content"][number],
      { type: "toolCall" }
    > => block.type === "toolCall")
    .map((block) => block.name);
}

function externalTool(
  definition: ExternalToolDefinition,
  capture: (call: ExternalToolCall) => void,
): AgentTool {
  const schema = Unsafe<Record<string, unknown>>(
    definition.parameters as TSchema,
  );
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: schema,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const call: ExternalToolCall = {
        id: toolCallId,
        name: definition.name,
        arguments: params as Record<string, unknown>,
      };
      capture(call);
      return {
        content: [{
          type: "text",
          text: "External action is pending execution by the caller-owned environment.",
        }],
        details: { kind: "external-action-proxy", call },
        terminate: true,
      };
    },
  };
}

function assertExternalDefinitions(
  definitions: readonly ExternalToolDefinition[],
): void {
  const seen = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/u.test(definition.name)) {
      throw new Error(`Invalid external tool name at index ${index}`);
    }
    if (MEMORY_TOOL_NAMES.has(definition.name)) {
      throw new Error(`External tool conflicts with Picorer tool: ${definition.name}`);
    }
    if (seen.has(definition.name)) {
      throw new Error(`Duplicate external tool: ${definition.name}`);
    }
    seen.add(definition.name);
    if (!definition.description.trim()) {
      throw new Error(`External tool ${definition.name} has no description`);
    }
    if (
      typeof definition.parameters !== "object" ||
      definition.parameters === null || Array.isArray(definition.parameters)
    ) {
      throw new Error(`External tool ${definition.name} has no JSON schema`);
    }
  }
}

/**
 * Stateful Pi Agent session for live environments. Memory tools execute inside
 * Picorer; caller-owned domain tools are returned to the environment and their
 * real tool results are appended before reasoning continues.
 */
export class InteractiveMemoryAgentSession {
  readonly sessionId = newRunId();

  private readonly agent: Agent;
  private readonly ledger: MemoryLedger;
  private readonly trace: InteractiveMemoryTraceEntry[] = [];
  private readonly pendingExternalCalls = new Map<string, ExternalToolCall>();
  private readonly externalToolNames: ReadonlySet<string>;
  private readonly skill: InteractiveMemorySkill;
  private readonly operatorCatalog: RuntimeSearchOperatorCatalog;
  private readonly maxTurnsPerInput: number;
  private readonly maxToolCallsPerInput: number;
  private readonly maxInputMs: number;
  private activeCapture: ExternalToolCall[] | undefined;
  private inputTurns = 0;
  private inputToolCalls = 0;
  private inputLimitError: string | undefined;
  private readonly activeToolArgs = new Map<string, unknown>();
  private evidenceFocus: string[] = [];

  constructor(private readonly options: InteractiveMemoryAgentOptions) {
    assertExternalDefinitions(options.externalTools);
    if (
      options.initialAssistantMessage !== undefined &&
      options.initialAssistantMessage.trim().length === 0
    ) {
      throw new Error("Initial assistant message must be non-empty");
    }
    this.skill = options.skill ?? "picorer-v0";
    this.ledger = new MemoryLedger(options.scopeId);
    this.externalToolNames = new Set(options.externalTools.map((tool) => tool.name));
    this.operatorCatalog = options.operatorRegistry.forkForRun(
      options.maxOperatorDefinitions ?? 8,
    );
    for (const definition of options.operatorDefinitions ?? []) {
      this.operatorCatalog.define(structuredClone(definition));
    }
    this.maxTurnsPerInput =
      options.maxTurnsPerInput ?? DEFAULT_INTERACTIVE_MEMORY_MAX_TURNS_PER_INPUT;
    this.maxToolCallsPerInput =
      options.maxToolCallsPerInput ??
      DEFAULT_INTERACTIVE_MEMORY_MAX_TOOL_CALLS_PER_INPUT;
    this.maxInputMs = options.maxInputMs ?? 300_000;

    const memoryTools = createPicorerTools({
      store: options.store,
      operatorRegistry: this.operatorCatalog,
      operatorDefinitions: this.operatorCatalog,
      scopeId: options.scopeId,
      ledger: this.ledger,
      evidenceFocus: () => this.evidenceFocus,
      searchDefaults: { limit: 20, order: "relevance" },
      ...(options.readOnlyNavigation === undefined
        ? {}
        : {
            bashRo: {
              ...options.readOnlyNavigation,
              store: options.store,
            },
          }),
    });
    const internalTools = [
      memoryTools.search,
      memoryTools.searchMore,
      ...(memoryTools.defineOperator === undefined
        ? []
        : [memoryTools.defineOperator]),
      memoryTools.read,
      ...(memoryTools.bashRo === undefined ? [] : [memoryTools.bashRo]),
    ];
    const proxies = options.externalTools.map((definition) =>
      externalTool(definition, (call) => this.activeCapture?.push(call))
    );
    const ephemeralContext = createEphemeralMemoryContext();
    this.agent = new Agent({
      initialState: {
        systemPrompt: interactiveMemorySystemPrompt({
          domainPolicy: options.domainPolicy,
          operatorRegistry: this.operatorCatalog,
          skill: this.skill,
        }),
        model: options.modelRuntime.model,
        thinkingLevel: options.modelRuntime.thinkingLevel,
        tools: [...internalTools, ...proxies],
        ...(options.initialAssistantMessage === undefined
          ? {}
          : {
              messages: [{
                role: "assistant" as const,
                content: [{
                  type: "text" as const,
                  text: options.initialAssistantMessage,
                }],
                api: options.modelRuntime.model.api,
                provider: options.modelRuntime.model.provider,
                model: options.modelRuntime.model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              }],
            }),
      },
      streamFn: options.modelRuntime.streamFn,
      getApiKey: options.modelRuntime.getApiKey,
      transformContext: ephemeralContext.transformContext,
      beforeToolCall: async (context) => {
        const names = toolNames(context);
        const containsMemory = names.some((name) => MEMORY_TOOL_NAMES.has(name));
        const containsExternal = names.some((name) =>
          this.externalToolNames.has(name)
        );
        if (
          containsMemory && containsExternal &&
          this.externalToolNames.has(context.toolCall.name)
        ) {
          return {
            block: true,
            reason:
              "Memory operations and domain action tools must be issued in separate assistant turns. Complete memory retrieval first, then call the domain tool.",
          };
        }
        return undefined;
      },
      toolExecution: "sequential",
      sessionId: this.sessionId,
    });
    this.agent.subscribe((event) => {
      if (event.type === "turn_start") {
        this.inputTurns += 1;
        if (this.inputTurns > this.maxTurnsPerInput) {
          this.inputLimitError =
            `Interactive Picorer exceeded its per-input turn budget ` +
            `(${this.maxTurnsPerInput})`;
          this.agent.abort();
        }
      } else if (event.type === "tool_execution_start") {
        this.inputToolCalls += 1;
        this.activeToolArgs.set(event.toolCallId, event.args);
        if (this.inputToolCalls > this.maxToolCallsPerInput) {
          this.inputLimitError =
            `Interactive Picorer exceeded its per-input tool-call budget ` +
            `(${this.maxToolCallsPerInput})`;
          this.agent.abort();
        }
      } else if (event.type === "tool_execution_end") {
        this.trace.push({
          step: this.trace.length + 1,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: this.activeToolArgs.get(event.toolCallId),
          isError: event.isError,
          ...(event.result.details === undefined
            ? {}
            : { details: event.result.details }),
        });
      }
    });
  }

  private toolResultMessages(results: readonly ExternalToolResult[]): ToolResultMessage[] {
    if (results.length === 0) throw new Error("Tool result batch is empty");
    const received = new Set(results.map((result) => result.toolCallId));
    const expected = new Set(this.pendingExternalCalls.keys());
    if (
      received.size !== expected.size ||
      [...expected].some((id) => !received.has(id))
    ) {
      throw new Error("External tool result IDs do not match pending calls");
    }
    return results.map((result) => {
      const pending = this.pendingExternalCalls.get(result.toolCallId)!;
      if (result.toolName !== pending.name) {
        throw new Error(`External tool result name mismatch for ${result.toolCallId}`);
      }
      return {
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
        timestamp: Date.now(),
      };
    });
  }

  async turn(input: InteractiveAgentInput): Promise<InteractiveAgentOutput> {
    if (input.type === "user" && this.pendingExternalCalls.size > 0) {
      throw new Error("Pending external tool calls must receive results first");
    }
    if (input.type === "tool-results" && this.pendingExternalCalls.size === 0) {
      throw new Error("No external tool calls are awaiting results");
    }
    this.evidenceFocus = [
      ...this.evidenceFocus,
      ...(input.type === "user"
        ? [input.content]
        : input.results.map((result) => result.content)),
    ].slice(-8);
    const prompt: string | ToolResultMessage[] = input.type === "user"
      ? input.content
      : this.toolResultMessages(input.results);
    if (input.type === "tool-results") this.pendingExternalCalls.clear();

    this.inputTurns = 0;
    this.inputToolCalls = 0;
    this.inputLimitError = undefined;
    const traceStart = this.trace.length;
    const messageStart = this.agent.state.messages.length;
    const captured: ExternalToolCall[] = [];
    this.activeCapture = captured;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.agent.abort();
    }, this.maxInputMs);
    timer.unref();
    try {
      if (typeof prompt === "string") await this.agent.prompt(prompt);
      else await this.agent.prompt(prompt);
    } finally {
      clearTimeout(timer);
      this.activeCapture = undefined;
    }
    if (timedOut) {
      throw new Error(`Interactive Picorer input exceeded ${this.maxInputMs}ms`);
    }
    if (this.inputLimitError !== undefined) {
      throw new Error(this.inputLimitError);
    }
    const assistant = lastAssistantMessage(this.agent.state.messages);
    if (assistant === undefined) {
      throw new Error("Interactive Picorer stopped without an assistant message");
    }
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(
        assistant.errorMessage ??
          `Interactive Picorer stopped with ${assistant.stopReason}`,
      );
    }
    if (captured.length > 0) {
      const capturedIds = new Set(captured.map((call) => call.id));
      this.agent.state.messages = this.agent.state.messages.filter((message) =>
        message.role !== "toolResult" || !capturedIds.has(message.toolCallId)
      );
      for (const call of captured) this.pendingExternalCalls.set(call.id, call);
    }
    const responseModel = assistant.responseModel ?? assistant.model;
    return {
      content: captured.length === 0
        ? assistantMessageText(assistant).trim() || null
        : null,
      toolCalls: captured,
      usage: aggregateAssistantUsage(
        this.agent.state.messages.slice(messageStart),
      ),
      model: {
        providerId: this.options.modelRuntime.providerId,
        modelId: this.options.modelRuntime.modelId,
        responseModel,
        thinkingLevel: this.options.modelRuntime.thinkingLevel,
        transport: this.options.modelRuntime.transport,
      },
      audit: {
        sessionId: this.sessionId,
        harnessVersion: PICORER_INTERACTIVE_HARNESS_VERSION,
        skill: {
          mode: this.skill,
          version: this.skill === "none" ? null : PICORER_ACTION_SKILL_VERSION,
          hash: this.skill === "none" ? null : PICORER_ACTION_SKILL_HASH,
        },
        operatorCatalogHash: this.operatorCatalog.identity().hash,
        operatorCatalog: this.operatorCatalog.identity(),
        operatorDefinitions: this.operatorCatalog.snapshots(),
        trace: this.trace.slice(traceStart),
        candidateCount: this.ledger.candidates.length,
        inspectedEvidenceCount: this.ledger.inspectedEvidence.length,
      },
    };
  }
}
