import { createMemoryObservation } from "./memory-observation.js";
import { createRequiredWorkingMemory, REQUIRED_WORKING_MEMORY_PROMPT } from "./required-working-memory.js";
import { WORK_PROGRESS_PROMPT } from "./work-progress-contract.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { createEphemeralMemoryContext } from "./ephemeral-context.js";
import {
  COMPACT_REWRITE_WORKING_MEMORY_PROMPT,
  createWorkingMemoryContext,
  REWRITE_WORKING_MEMORY_PROMPT,
  WORKING_MEMORY_POLICY_PROMPT,
} from "./working-memory-context.js";
import {
  aggregateAssistantUsage,
  assistantMessageText,
  lastAssistantMessage,
  validateResponseModels,
} from "./assistant-messages.js";
import {
  picorerSystemPrompt,
  type PicorerSkill,
} from "./retrieval-prompt.js";
import { MemoryLedger } from "../../model/ledger.js";
import type { PiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import {
  createToolProtocolBeforeToolCall,
  createPicorerTools,
  type MemoryToolStore,
} from "./tools.js";
import type {
  ModelUsage,
  PicorerResult,
  ToolTraceEntry,
} from "../../model/evidence.js";
import type {
  RetrievalMetadata,
  RetrievalMetricsSnapshot,
  SearchOperatorCatalogIdentity,
  SearchOperatorDefinition,
  SearchOperatorDefinitionSnapshot,
  SearchOperatorRegistry,
} from "../../../retrieval/index.js";
import type { MemoryRecord } from "../../../memory/index.js";
import { assertNonEmpty, newRunId } from "../../../util.js";
import type { ReadOnlyNavigationBinding } from "../../ports/read-only-navigation.js";

export const PICORER_HARNESS_VERSION = "picorer-evidence-transaction-v2";

export type PicorerInterfaceMode = "full" | "compact";

export interface PicorerRuntimeStore extends MemoryToolStore {
  findMentionedMemoryIds(scopeId: string, text: string): string[];
  getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[];
  getRetrievalMetadata?(): RetrievalMetadata;
  snapshotRetrievalMetrics?(): RetrievalMetricsSnapshot;
}

export interface RunPicorerOptions {
  store: PicorerRuntimeStore;
  operatorRegistry: SearchOperatorRegistry;
  modelRuntime: PiModelRuntime;
  scopeId: string;
  question: string;
  questionDate?: string;
  readOnlyNavigation?: ReadOnlyNavigationBinding;
  maxTurns?: number;
  maxToolCalls?: number;
  /** Optional evaluation/runtime budget for actual search executions. */
  maxSearchCalls?: number;
  maxProtocolNudges?: number;
  maxRunMs?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  skill?: PicorerSkill;
  /** Controls presentation and history compaction independently of retrieval guidance. */
  interfaceMode?: PicorerInterfaceMode;
  /** Experimental full-interface note acknowledgement; default off. */
  requireWorkingMemory?: boolean;
  /** Opt-in note-driven context with acknowledged tool-result expiry. */
  contextPolicy?: "current-window" | "working-memory-rewrite" | "working-memory-v2" | "working-memory-v3";
  /** Approved declarative operators loaded into this run before the Agent starts. */
  operatorDefinitions?: readonly SearchOperatorDefinition[];
  /** Total preloaded plus Agent-created retrieval plans. Defaults to 4. */
  maxOperatorDefinitions?: number;
}

export interface PicorerFailureDiagnostics {
  runId: string;
  scopeId: string;
  turns: number;
  toolCalls: number;
  lastAssistantText: string;
  candidates: PicorerResult["candidates"];
  evidence: PicorerResult["evidence"];
  trace: ToolTraceEntry[];
  workingMemory?: PicorerResult["workingMemory"];
  operatorCatalog?: SearchOperatorCatalogIdentity;
  operatorDefinitions?: SearchOperatorDefinitionSnapshot[];
  providerFailureKind?: PicorerProviderFailureKind;
  providerResponseModel?: string;
  usage: ModelUsage;
}

export type PicorerProviderFailureKind =
  | "content_filter"
  | "http_error"
  | "invalid_finish_reason"
  | "invalid_json"
  | "invalid_response"
  | "model_substitution"
  | "request_timeout"
  | "transport_error"
  | "unknown";

export type PicorerFailureCode =
  | "tool_protocol_exhausted"
  | "run_timeout"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "provider_error"
  | "runtime_error";

export class PicorerRunError extends Error {
  readonly code: PicorerFailureCode;
  readonly diagnostics: PicorerFailureDiagnostics;

  constructor(
    message: string,
    diagnostics: PicorerFailureDiagnostics,
    code: PicorerFailureCode = "runtime_error",
  ) {
    super(message);
    this.name = "PicorerRunError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const MAX_FINISH_FAILURES = 2;

function providerFailureKind(message: string): PicorerProviderFailureKind {
  if (/content_filter/iu.test(message)) return "content_filter";
  if (/invalid finish_reason/iu.test(message)) return "invalid_finish_reason";
  if (/substituted model/iu.test(message)) return "model_substitution";
  if (/invalid JSON/iu.test(message)) return "invalid_json";
  if (/(?:contains no (?:choices|message)|invalid .*response)/iu.test(message)) {
    return "invalid_response";
  }
  if (/(?:timed?\s*out|timeout|ETIMEDOUT)/iu.test(message)) {
    return "request_timeout";
  }
  if (/\bHTTP(?:\s+error)?\s*[:=]?\s*\d{3}\b/iu.test(message)) {
    return "http_error";
  }
  if (/(?:fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN)/iu.test(message)) {
    return "transport_error";
  }
  return "unknown";
}

function providerResponseModel(message: string): string | undefined {
  return message.match(
    /^Provider substituted model ([a-zA-Z0-9._:/-]{1,128}); expected /u,
  )?.[1];
}

function questionPrompt(
  question: string,
  questionDate?: string,
  compact = false,
): string {
  if (compact) {
    return [
      "Question:",
      question,
      ...(questionDate === undefined
        ? []
        : ["", `Question date (source timezone unspecified): ${questionDate}`]),
      "",
      "Find and read exact source evidence. Search from the facts still missing. " +
        "Use or compose the available search operators when that improves the retrieval path. " +
        "Treat only relationships stated by sources you have read as established; " +
        "do not substitute world knowledge for a missing relation. " +
        "Decide whether the acquired sources are adequate for answering. " +
        "Do not answer the question.",
    ].join("\n");
  }
  return [
    "Question:",
    question,
    ...(questionDate === undefined
      ? []
      : ["", `Question date (source timezone unspecified): ${questionDate}`]),
    "",
      "Use the available memory operations to find and read direct source " +
      "evidence. Keep workingMemory current. For an open set, use honest " +
      "frontier saturation rather than claiming ground-truth completeness. " +
      "After observing the final search or read result, call finish alone in a " +
      "later assistant turn with status; evidenceSummary is optional. " +
      "Every exact source returned by read enters the final source package. " +
      "Do not answer the question.",
  ].join("\n");
}

/**
 * Runs one fresh Pi Agent per question. The accepted finish tool call is a
 * cited evidence package; free-form assistant text is never treated as output.
 */
export async function runPicorer(
  options: RunPicorerOptions,
): Promise<PicorerResult> {
  options.signal?.throwIfAborted();
  const skill = options.skill ?? "picorer-v0";
  const interfaceMode = options.interfaceMode ?? (
    skill === "picorer-minimal" ? "compact" : "full"
  );
  const compactInterface = interfaceMode === "compact";
  const contextPolicy = options.contextPolicy ?? (
    compactInterface ? "working-memory-rewrite" : undefined
  );
  if (contextPolicy !== undefined && contextPolicy !== "current-window" &&
      contextPolicy !== "working-memory-v2" && contextPolicy !== "working-memory-v3" && contextPolicy !== "working-memory-rewrite") {
    throw new Error("Unsupported contextPolicy. Use working-memory-rewrite for a single note, working-memory-v2 for entries or working-memory-v3 for current task progress; the old working-memory-v1 replacement policy is available only in its frozen experiment snapshot.");
  }
  if (options.requireWorkingMemory && (compactInterface || (contextPolicy !== undefined && contextPolicy !== "current-window"))) {
    throw new Error("requireWorkingMemory requires full interface with current-window context.");
  }
  const scopeId = assertNonEmpty(options.scopeId, "scopeId");
  const question = assertNonEmpty(options.question, "question");
  const runId = newRunId();
  const ledger = new MemoryLedger(scopeId);
  const trace: ToolTraceEntry[] = [];
  const callArgs = new Map<string, unknown>();
  const maxTurns = options.maxTurns ?? 16;
  const maxToolCalls = options.maxToolCalls ?? 40;
  const maxProtocolNudges = options.maxProtocolNudges ?? 2;
  const maxRunMs = options.maxRunMs ?? 120_000;
  let turns = 0;
  let toolCalls = 0;
  let finishFailures = 0;
  let finishFailureMessage: string | undefined;
  let budgetFailure:
    | {
      code: "turn_budget_exhausted" | "tool_budget_exhausted";
      message: string;
    }
    | undefined;
  const finishCallsTerminatedByGuard = new Set<string>();
  let timedOut = false;
  const retrieval = options.store.getRetrievalMetadata?.() ?? {
    retrievalProfile: "fts5" as const,
  };
  const zeroRetrievalMetrics: RetrievalMetricsSnapshot = {
    embeddingCalls: 0,
    embeddingLatencyMs: 0,
    denseCandidateCount: 0,
    rerankCandidateCount: 0,
    denseFallbackCount: 0,
  };
  const retrievalMetricsBefore =
    options.store.snapshotRetrievalMetrics?.() ?? zeroRetrievalMetrics;
  const workingMode = contextPolicy === "working-memory-rewrite" ? "rewrite"
    : contextPolicy === "working-memory-v3" ? "progress"
    : contextPolicy === "working-memory-v2" ? "entries" : undefined;
  const workingContext = workingMode === undefined ? undefined
    : createWorkingMemoryContext(
        ledger,
        options.maxSearchCalls,
        workingMode,
        compactInterface,
      );
  const workingPrompt = workingMode === "rewrite" && compactInterface
    ? COMPACT_REWRITE_WORKING_MEMORY_PROMPT
    : workingMode === "rewrite" ? REWRITE_WORKING_MEMORY_PROMPT
    : workingMode === "progress" ? WORK_PROGRESS_PROMPT : WORKING_MEMORY_POLICY_PROMPT;
  const adaptiveTools = workingMode === "progress" || workingMode === "rewrite";
  const ephemeralContext = workingContext ?? createEphemeralMemoryContext();
  const operatorCatalog = options.operatorRegistry.forkForRun(
    options.maxOperatorDefinitions ?? 4,
  );
  for (const definition of options.operatorDefinitions ?? []) {
    operatorCatalog.define(structuredClone(definition));
  }
  const requiredObservation = options.requireWorkingMemory ? createMemoryObservation({
    ledger, question,
    ...(options.questionDate === undefined ? {} : { questionDate: options.questionDate }),
    ...(options.maxSearchCalls === undefined ? {} : { maxSearchCalls: options.maxSearchCalls }),
  }) : undefined;
  const requiredMemory = requiredObservation === undefined ? undefined : createRequiredWorkingMemory(requiredObservation);
  const tools = createPicorerTools({
    store: options.store,
    operatorRegistry: operatorCatalog,
    operatorDefinitions: operatorCatalog,
    scopeId,
    ledger,
    question,
    ...(workingContext === undefined ? {} : { observation: workingContext.observation }),
    ...(requiredObservation === undefined ? {} : { observation: requiredObservation }),
    ...(options.questionDate === undefined
      ? {}
      : { questionDate: options.questionDate }),
    searchDefaults: {
      limit: 20,
      order: "relevance",
    },
    interfaceMode,
    ...(options.maxSearchCalls === undefined
      ? {}
      : { maxSearchCalls: options.maxSearchCalls }),
    ...(options.readOnlyNavigation === undefined
      ? {}
      : {
          bashRo: {
            ...options.readOnlyNavigation,
            store: options.store,
          },
        }),

  });
  const agentTools = requiredMemory?.wrapTools(tools.all) ?? workingContext?.wrapTools(tools.all) ?? tools.all;
  const enforceToolProtocol = createToolProtocolBeforeToolCall();
  const agent = new Agent({
    initialState: {
      systemPrompt: picorerSystemPrompt(
        skill,
        options.systemPrompt,
        operatorCatalog.list(),
      ) + (workingContext === undefined ? "" : workingPrompt)
        + (requiredMemory === undefined ? "" : REQUIRED_WORKING_MEMORY_PROMPT),
      model: options.modelRuntime.model,
      thinkingLevel: options.modelRuntime.thinkingLevel,
      tools: workingContext?.availableTools(agentTools) ?? agentTools,
    },
    ...(!adaptiveTools ? {} : {
      prepareNextTurnWithContext: ({ context }: import("@earendil-works/pi-agent-core").PrepareNextTurnContext) => ({ context: { ...context, tools: workingContext!.availableTools(agentTools) } }),
    }),
    streamFn: options.modelRuntime.streamFn,
    getApiKey: options.modelRuntime.getApiKey,
    transformContext: async (messages) => {
      requiredMemory?.observe(messages);
      return ephemeralContext.transformContext(messages);
    },
    beforeToolCall: enforceToolProtocol,
    afterToolCall: async (context) => {
      if (
        context.toolCall.name === "finish" && context.isError &&
        finishFailures + 1 >= MAX_FINISH_FAILURES
      ) {
        finishCallsTerminatedByGuard.add(context.toolCall.id);
        return { terminate: true };
      }
      return undefined;
    },
    toolExecution: "sequential",
    sessionId: runId,
  });

  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      turns += 1;
      if (turns > maxTurns) {
        budgetFailure ??= {
          code: "turn_budget_exhausted",
          message: `Picorer exceeded the ${maxTurns}-turn budget`,
        };
        agent.abort();
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      callArgs.set(event.toolCallId, event.args);
      if (toolCalls > maxToolCalls) {
        budgetFailure ??= {
          code: "tool_budget_exhausted",
          message: `Picorer exceeded the ${maxToolCalls}-tool-call budget`,
        };
        agent.abort();
      }
      return;
    }
    if (event.type === "tool_execution_end") {
      // The next-turn hook updates an active loop; state also feeds fresh loops
      // started by protocol nudges, which do not run that hook before turn one.
      if (adaptiveTools) {
        agent.state.tools = workingContext!.availableTools(agentTools);
      }
      trace.push({
        step: trace.length + 1,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: callArgs.get(event.toolCallId),
        isError: event.isError,
        ...(
          event.result !== undefined &&
          typeof event.result === "object" &&
          event.result !== null &&
          "content" in event.result
            ? { content: event.result.content }
            : {}
        ),
        ...(
          event.result !== undefined &&
          typeof event.result === "object" &&
          event.result !== null &&
          "details" in event.result
            ? { details: event.result.details }
            : {}
        ),
      });
      // Successful work gives the model another bounded chance to correct finish.
      // Total turn/tool/search budgets still bound repeated recovery attempts.
      if (!event.isError && event.toolName !== "finish") finishFailures = 0;
      if (event.toolName === "finish" && event.isError) {
        finishFailures += 1;
        if (finishFailures >= MAX_FINISH_FAILURES) {
          finishFailureMessage =
            `Protocol error: finish failed ${finishFailures} times; ` +
            "without a successful intervening tool action; terminating the correction loop.";
          if (!finishCallsTerminatedByGuard.has(event.toolCallId)) {
            // Argument-schema failures bypass afterToolCall, so abort the active
            // loop here. The provider receives the already-aborted signal before
            // any attempted continuation.
            agent.abort();
          }
        }
      }
    }
  });

  const failure = (
    code: PicorerFailureCode,
    message: string,
  ): PicorerRunError => {
    const responseModel = code === "provider_error"
      ? providerResponseModel(message)
      : undefined;
    return new PicorerRunError(message, {
      runId,
      scopeId,
      turns,
      toolCalls,
      lastAssistantText: assistantMessageText(
        lastAssistantMessage(agent.state.messages),
        4_000,
      ),
      candidates: ledger.candidates,
      evidence: ledger.inspectedEvidence,
      trace: [...trace],
      ...(workingContext ? { workingMemory: workingContext.workingMemorySnapshot() } : {}),
      operatorCatalog: operatorCatalog.identity(),
      operatorDefinitions: operatorCatalog.snapshots(),
      ...(code === "provider_error"
        ? {
            providerFailureKind: providerFailureKind(message),
            ...(responseModel === undefined
              ? {}
              : { providerResponseModel: responseModel }),
          }
        : {}),
      usage: aggregateAssistantUsage(agent.state.messages),
    }, code);
  };

  const guardFailure = (): PicorerRunError | undefined => {
    if (options.signal?.aborted) {
      return failure("runtime_error", "Picorer was cancelled by its caller");
    }
    if (timedOut) {
      return failure(
        "run_timeout",
        `Picorer exceeded the ${maxRunMs}ms run limit`,
      );
    }
    if (budgetFailure !== undefined) {
      return failure(budgetFailure.code, budgetFailure.message);
    }
    if (finishFailureMessage !== undefined) {
      return failure("tool_protocol_exhausted", finishFailureMessage);
    }
    return undefined;
  };

  const runTimer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, maxRunMs);
  runTimer.unref();
  const abortFromCaller = (): void => agent.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    try {
      await agent.prompt(questionPrompt(
        question,
        options.questionDate,
        compactInterface,
      ));
    } catch (error) {
      throw guardFailure() ?? failure(
        "runtime_error",
        error instanceof Error ? error.message : String(error),
      );
    }
    for (let nudge = 0; ledger.selection === undefined; nudge += 1) {
      const stoppedByGuard = guardFailure();
      if (stoppedByGuard !== undefined) throw stoppedByGuard;
      const lastAssistant = lastAssistantMessage(agent.state.messages);
      if (
        lastAssistant?.stopReason === "error" ||
        lastAssistant?.stopReason === "aborted"
      ) {
        throw failure(
          lastAssistant.stopReason === "error"
            ? "provider_error"
            : "runtime_error",
          lastAssistant.errorMessage ??
            `Picorer agent stopped with ${lastAssistant.stopReason}`,
        );
      }
      if (agent.state.errorMessage) {
        throw failure("provider_error", agent.state.errorMessage);
      }
      if (nudge >= maxProtocolNudges) break;
      try {
        await agent.prompt(compactInterface
          ? "Protocol reminder: do not answer. Search or read if a required fact is missing; otherwise call finish alone with an honest status."
          : "Protocol reminder: do not answer the question. Continue retrieval " +
            "if a useful evidence need or frontier remains; otherwise call " +
            "finish as the only tool call in this turn, with an honest status " +
            "(evidenceSummary is optional). Read " +
            "the preceding search frontier or exact READ_RESULT before " +
            "finishing. Every source returned by read is committed; the harness " +
            "generates its citations and provenance.");
      } catch (error) {
        throw guardFailure() ?? failure(
          "runtime_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    clearTimeout(runTimer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  const stoppedByGuard = guardFailure();
  if (stoppedByGuard !== undefined) throw stoppedByGuard;

  const selection = ledger.selection;
  if (!selection) {
    const lastAssistant = lastAssistantMessage(agent.state.messages);
    throw failure(
      "tool_protocol_exhausted",
      `Protocol error: Picorer stopped without calling finish ` +
        `(turns=${turns}, tools=${toolCalls}, lastStopReason=${
          lastAssistant?.stopReason ?? "none"
        })`,
    );
  }
  const candidates = ledger.candidates;
  const evidenceById = new Map(
    ledger.inspectedEvidence.map((item) => [item.memoryId, item]),
  );
  const evidence = selection.citations.map((citation) => {
    const item = evidenceById.get(citation.memoryId);
    if (!item) {
      throw failure(
        "runtime_error",
        `Cited evidence disappeared: ${citation.memoryId}`,
      );
    }
    return item;
  });
  const retrievalMetricsAfter =
    options.store.snapshotRetrievalMetrics?.() ?? zeroRetrievalMetrics;
  const retrievalMetrics = {
    embeddingCalls: Math.max(
      0,
      retrievalMetricsAfter.embeddingCalls - retrievalMetricsBefore.embeddingCalls,
    ),
    embeddingLatencyMs: Math.max(
      0,
      retrievalMetricsAfter.embeddingLatencyMs -
        retrievalMetricsBefore.embeddingLatencyMs,
    ),
    denseCandidateCount: Math.max(
      0,
      retrievalMetricsAfter.denseCandidateCount -
        retrievalMetricsBefore.denseCandidateCount,
    ),
    rerankCandidateCount: Math.max(
      0,
      retrievalMetricsAfter.rerankCandidateCount -
        retrievalMetricsBefore.rerankCandidateCount,
    ),
    denseFallbackCount: Math.max(
      0,
      retrievalMetricsAfter.denseFallbackCount -
        retrievalMetricsBefore.denseFallbackCount,
    ),
  };
  const responseModels = validateResponseModels(
    agent.state.messages,
    options.modelRuntime.modelId,
  );
  const base: PicorerResult = {
    runId,
    scopeId,
    question,
    status: selection.status,
    citations: selection.citations,
    ...(selection.evidenceSummary === undefined ? {} : { evidenceSummary: selection.evidenceSummary }),
    ...(selection.count === undefined ? {} : { count: selection.count }),
    ...(selection.inventory === undefined
      ? {}
      : { inventory: selection.inventory }),
    candidates,
    evidence,
    trace,
    ...(workingContext ? { workingMemory: workingContext.workingMemorySnapshot() } : {}),
    operatorCatalog: operatorCatalog.identity(),
    operatorDefinitions: operatorCatalog.snapshots(),
    metrics: {
      searchCalls: trace.filter(
        (item) => item.toolName === "search" && !item.isError,
      ).length,
      readCalls: trace.filter((item) => item.toolName === "read").length,
      bashCalls: trace.filter((item) => item.toolName === "bash_ro").length,
      operatorDefinitionCalls: trace.filter(
        (item) => item.toolName === "define_operator",
      ).length,
      candidateCount: candidates.length,
      inspectedEvidenceCount: ledger.inspectedEvidence.length,
      evidenceCount: evidence.length,
      citedCount: selection.citations.length,
      retrievalProfile: retrieval.retrievalProfile,
      ...retrievalMetrics,
      expiredNavigationResults:
        ephemeralContext.snapshot().expiredNavigationResults,
      compactedReadResults:
        ephemeralContext.snapshot().compactedReadResults,
    },
    retrieval,
    retrievalModel: {
      providerId: options.modelRuntime.providerId,
      modelId: options.modelRuntime.modelId,
      responseModels,
      thinkingLevel: options.modelRuntime.thinkingLevel,
      transport: options.modelRuntime.transport,
    },
    usage: aggregateAssistantUsage(agent.state.messages),
  };
  return options.questionDate === undefined
    ? base
    : { ...base, questionDate: options.questionDate };
}
