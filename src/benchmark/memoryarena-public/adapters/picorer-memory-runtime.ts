import {
  OperatorEvolutionCatalog,
  runPicorer,
  type PicorerResult,
  type PicorerRuntimeStore,
  type PicorerInterfaceMode,
  type PicorerSkill,
  type RunPicorerOptions,
} from "../../../evidence-agent/index.js";
import type { OnlineMemoryStore } from "../../../memory/index.js";
import type { PiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import type { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import {
  indexScopeEmbeddings,
  type Embedder,
  type SearchOperatorRegistry,
} from "../../../retrieval/index.js";
import { sha256 } from "../../../util.js";
import {
  MemoryArenaPublicError,
  type MemoryArenaOperatorExperimentInput,
  type MemoryArenaOriginalChunk,
  type MemoryArenaAppendMessage,
  type MemoryArenaRetrievalResult,
} from "../model/memory-backend.js";
import type {
  MemoryArenaChunkMemory,
  MemoryArenaEvidenceRetriever,
} from "../ports/memory-backend.js";

type RunPicorer = typeof runPicorer;

export interface PicorerMemoryArenaAdapterOptions {
  rawStore: MemoryStore & OnlineMemoryStore;
  runtimeStore: PicorerRuntimeStore;
  operatorRegistry: SearchOperatorRegistry;
  retrievalContextForScope?: (scopeId: string) => Promise<{
    store: PicorerRuntimeStore;
    operatorRegistry: SearchOperatorRegistry;
  }>;
  embedder: Embedder;
  modelRuntime: PiModelRuntime;
  skill?: PicorerSkill;
  interfaceMode?: PicorerInterfaceMode;
  maxRunMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  runPicorerImpl?: RunPicorer;
}

export function memoryArenaPublicScopeId(
  userId: string,
  generation: number,
): string {
  return `memoryarena-${sha256(userId).slice(0, 24)}-g${generation}`;
}

function appendRequestIdentity(options: {
  userId: string;
  generation: number;
  ordinal: number;
  chunk: string;
  messages?: readonly MemoryArenaAppendMessage[];
}): { requestId: string; requestHash: string; sourceSessionId: string } {
  const userHash = sha256(options.userId).slice(0, 24);
  const sourceSessionId = `chunk-${options.ordinal}`;
  return {
    requestId:
      `memoryarena-${userHash}-g${options.generation}-o${options.ordinal}`,
    requestHash: sha256(JSON.stringify({
      userId: options.userId,
      generation: options.generation,
      ordinal: options.ordinal,
      chunk: options.chunk,
      ...(options.messages === undefined ? {} : { messages: options.messages }),
    })),
    sourceSessionId,
  };
}

export function memoryArenaRetryableUpstreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP(?:\s+error)?\s*[:=]?\s*(?:408|425|429|5\d\d)\b|(?:408|425|429|5\d\d)\s+status\s+code\b|status(?:\s+code)?\s*[:=]\s*(?:408|425|429|5\d\d)\b|error\s+code\s*[:=]\s*(?:408|425|429|5\d\d)\b|rate[ -]?limit|too many requests|timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|temporar(?:y|ily) unavailable|service unavailable)/iu.test(
    message,
  );
}

export function memoryArenaUpstreamAuthStatus(
  error: unknown,
): 401 | 403 | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const contextualStatus = message.match(
    /(?:\bHTTP(?:\s+error)?(?:\s+status(?:\s+code)?)?\s*[:=]?\s*(401|403)\b|\b(401|403)\s+status\s+code\b|\bstatus(?:\s+code)?\s*[:=]\s*(401|403)\b|\berror\s+code\s*[:=]\s*(401|403)\b)/iu,
  );
  const status = contextualStatus?.slice(1).find((value) => value !== undefined);
  if (status === "401" || /(?:invalid|incorrect|missing)\s+(?:api[ -]?)?key\b|invalid authentication|authentication failed|\bunauthori[sz]ed\b/iu.test(message)) {
    return 401;
  }
  if (status === "403" || /\bforbidden\b|permission denied/iu.test(message)) {
    return 403;
  }
  return undefined;
}

function mapUpstreamError(
  error: unknown,
  operation: string,
): never {
  let mapped: unknown = error;
  const authStatus = memoryArenaUpstreamAuthStatus(error);
  if (!(error instanceof MemoryArenaPublicError) && authStatus !== undefined) {
    mapped = new MemoryArenaPublicError({
      code: authStatus === 401
        ? "upstream_unauthorized"
        : "upstream_forbidden",
      message: authStatus === 401
        ? `Picorer ${operation} upstream authentication failed`
        : `Picorer ${operation} is forbidden by the upstream provider`,
      httpStatus: authStatus,
      retryable: false,
      cause: error,
    });
  } else if (
    !(error instanceof MemoryArenaPublicError) &&
    memoryArenaRetryableUpstreamError(error)
  ) {
    mapped = new MemoryArenaPublicError({
      code: "upstream_unavailable",
      message: `Picorer ${operation} is temporarily unavailable`,
      httpStatus: 503,
      retryable: true,
      cause: error,
    });
  } else if (!(error instanceof MemoryArenaPublicError)) {
    const picorerFailure = memoryArenaPicorerRunFailure(error);
    if (picorerFailure !== undefined) mapped = picorerFailure;
  }
  throw mapped;
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

/** Converts Picorer method/provider failures into a stable, content-free API policy. */
export function memoryArenaPicorerRunFailure(
  error: unknown,
): MemoryArenaPublicError | undefined {
  if (!(error instanceof Error) || error.name !== "PicorerRunError") {
    return undefined;
  }
  const rawCode = errorRecord(error)?.code;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  if (
    code === "tool_protocol_exhausted" ||
    (code === undefined && /^Protocol error:/u.test(error.message))
  ) {
    return new MemoryArenaPublicError({
      code: "retrieval_agent_protocol_error",
      message: "Picorer retrieval agent stopped without a valid finish result",
      httpStatus: 422,
      retryable: false,
      cause: error,
    });
  }
  if (
    code === "turn_budget_exhausted" ||
    code === "tool_budget_exhausted"
  ) {
    return new MemoryArenaPublicError({
      code: "retrieval_agent_budget_exhausted",
      message: "Picorer retrieval agent exhausted its execution budget",
      httpStatus: 422,
      retryable: false,
      cause: error,
    });
  }
  if (
    code === "run_timeout" ||
    (code === undefined && /exceeded the \d+ms run limit/iu.test(error.message))
  ) {
    return new MemoryArenaPublicError({
      code: "retrieval_agent_timeout",
      message: "Picorer retrieval agent exceeded its run time limit",
      httpStatus: 504,
      retryable: false,
      cause: error,
    });
  }
  if (
    code === "provider_error" ||
    (code === undefined && /(?:\bprovider\b|chat completion|finish_reason)/iu.test(
      error.message,
    ))
  ) {
    return new MemoryArenaPublicError({
      code: "upstream_failure",
      message: "Picorer retrieval provider returned a non-transient failure",
      httpStatus: 502,
      retryable: false,
      cause: error,
    });
  }
  return new MemoryArenaPublicError({
    code: "retrieval_agent_failed",
    message: "Picorer retrieval agent failed",
    httpStatus: 500,
    retryable: false,
    cause: error,
  });
}

/** Maps the official memory backend lifecycle onto immutable Picorer source chunks. */
export class PicorerMemoryArenaAdapter
  implements MemoryArenaChunkMemory, MemoryArenaEvidenceRetriever {
  private readonly run: RunPicorer;

  constructor(private readonly options: PicorerMemoryArenaAdapterOptions) {
    this.run = options.runPicorerImpl ?? runPicorer;
  }

  async appendOriginalChunk(options: {
    userId: string;
    generation: number;
    ordinal: number;
    chunk: string;
    messages?: readonly MemoryArenaAppendMessage[];
  }): Promise<void> {
    const scopeId = memoryArenaPublicScopeId(options.userId, options.generation);
    const identity = appendRequestIdentity(options);
    let appended: ReturnType<MemoryStore["appendMemoryRequest"]>;
    try {
      appended = this.options.rawStore.appendMemoryRequest({
        requestId: identity.requestId,
        requestHash: identity.requestHash,
        scopeId,
        sourceSessionId: identity.sourceSessionId,
        messages: options.messages ?? [{ role: "other", content: options.chunk }],
      });
    } catch (error) {
      mapUpstreamError(error, "memory append");
    }

    try {
      const indexed = await indexScopeEmbeddings(
        this.options.rawStore,
        scopeId,
        this.options.embedder,
      );
      if (indexed.total === 0 || indexed.missing !== 0) {
        throw new Error(
          `MemoryArena embedding index is incomplete for ${scopeId}: ` +
          `${indexed.indexed}/${indexed.total}`,
        );
      }
      if (appended.status === "pending") {
        this.options.rawStore.markAppendRequestComplete(
          identity.requestId,
          identity.requestHash,
        );
      }
    } catch (error) {
      mapUpstreamError(error, "memory append");
    }
  }

  async readOriginalChunks(options: {
    userId: string;
    generation: number;
    memoryIds: readonly string[];
  }): Promise<MemoryArenaOriginalChunk[]> {
    const scopeId = memoryArenaPublicScopeId(options.userId, options.generation);
    return this.options.rawStore
      .getRecords(scopeId, [...options.memoryIds])
      .map((record) => ({ memoryId: record.memoryId, content: record.content }));
  }

  async retrieve(options: {
    userId: string;
    generation: number;
    question: string;
    operatorExperiment?: MemoryArenaOperatorExperimentInput;
  }): Promise<MemoryArenaRetrievalResult> {
    const scopeId = memoryArenaPublicScopeId(options.userId, options.generation);
    try {
      const retrieval = this.options.retrievalContextForScope === undefined
        ? {
            store: this.options.runtimeStore,
            operatorRegistry: this.options.operatorRegistry,
          }
        : await this.options.retrievalContextForScope(scopeId);
      const experiment = options.operatorExperiment;
      const evolution = experiment?.mode === "cumulative"
        ? experiment.evolutionSnapshot === undefined
          ? new OperatorEvolutionCatalog({
              capacity: 4,
              explorationSlots: 1,
              promotionQuestions: 2,
            })
          : OperatorEvolutionCatalog.restore(experiment.evolutionSnapshot)
        : undefined;
      const runtimeOptions: RunPicorerOptions = {
        store: retrieval.store,
        operatorRegistry: retrieval.operatorRegistry,
        modelRuntime: this.options.modelRuntime,
        scopeId,
        question: options.question,
        skill: this.options.skill ?? "picorer-v0",
        ...(this.options.interfaceMode === undefined
          ? {}
          : { interfaceMode: this.options.interfaceMode }),
        ...(experiment === undefined
          ? {}
          : {
              maxSearchCalls: experiment.maxSearchCalls,
              maxOperatorDefinitions: experiment.mode === "static" ? 0 : 4,
              operatorDefinitions: evolution?.definitionsForNextQuestion() ?? [],
            }),
        ...(this.options.maxRunMs === undefined
          ? {}
          : { maxRunMs: this.options.maxRunMs }),
        ...(this.options.maxTurns === undefined
          ? {}
          : { maxTurns: this.options.maxTurns }),
        ...(this.options.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: this.options.maxToolCalls }),
      };
      const result: PicorerResult = await this.run(runtimeOptions);
      const observation = evolution?.observe(experiment!.questionId, result);
      const evolutionSnapshot = evolution?.snapshot();
      const operatorExperiment = experiment === undefined
        ? undefined
        : {
            mode: experiment.mode,
            questionId: experiment.questionId,
            maxSearchCalls: experiment.maxSearchCalls,
            retrievalStatus: result.status,
            searchCalls: result.metrics.searchCalls,
            operatorDefinitions: result.operatorDefinitions.map((item) =>
              structuredClone(item)
            ),
            ...(observation === undefined ? {} : { observation }),
            ...(evolutionSnapshot === undefined ? {} : { evolutionSnapshot }),
          };
      return {
        runId: result.runId,
        status: result.status,
        citations: result.citations.map((citation) => ({ ...citation })),
        ...(result.evidenceSummary === undefined ? {} : { evidenceSummary: result.evidenceSummary }),
        evidence: result.evidence.map((source) => ({
          ...source,
          excerpts: source.excerpts.map((excerpt) => ({ ...excerpt })),
          metadata: structuredClone(source.metadata),
        })),
        ...(result.inventory === undefined
          ? {}
          : {
              inventory: result.inventory.map((item) => ({
                item: item.item,
                memoryIds: [...item.memoryIds],
              })),
            }),
        trace: result.trace.map((entry) => ({ ...entry })),
        usage: {
          ...result.usage,
          cost: { ...result.usage.cost },
        },
        retrievalModel: {
          ...result.retrievalModel,
          responseModels: [...result.retrievalModel.responseModels],
        },
        audit: {
          ...(result.evidenceSummary === undefined ? {} : { evidence_summary: result.evidenceSummary }),
          metrics: result.metrics,
          retrieval: result.retrieval,
          retrieval_model: result.retrievalModel,
          candidates: result.candidates,
          evidence: result.evidence,
        },
        ...(operatorExperiment === undefined ? {} : { operatorExperiment }),
      };
    } catch (error) {
      mapUpstreamError(error, "retrieval");
    }
  }
}
