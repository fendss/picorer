import { createHash } from "node:crypto";
import { renderEvidenceExcerpts } from "../../../evidence-agent/index.js";
import {
  MemoryArenaPublicError,
  MemoryArenaOperationDiagnosticError,
  memorySystemMismatch,
  unsupportedMemorySystem,
  userNotInitialized,
  type MemoryArenaAddInput,
  type MemoryArenaAddResult,
  type MemoryArenaGenerationState,
  type MemoryArenaCommittedEvidence,
  type MemoryArenaInitializeInput,
  type MemoryArenaInitializeResult,
  type MemoryArenaOperationAuditFailure,
  type MemoryArenaOperationFailedRetrieval,
  type MemoryArenaOperationAuditStart,
  type MemoryArenaOperationAuditSuccess,
  type MemoryArenaOperationEmbeddingAudit,
  type MemoryArenaRetrievalResult,
  type MemoryArenaWrapInput,
  type MemoryArenaWrapResult,
} from "../model/memory-backend.js";
import type {
  MemoryArenaOperationAuditSpan,
  MemoryArenaPublicBackendDependencies,
} from "../ports/memory-backend.js";
import { memoryArenaPicorerFailureDiagnostics } from "../model/failure-diagnostics.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operationFailure(error: unknown): MemoryArenaOperationAuditFailure {
  const retrieval = memoryArenaPicorerFailureDiagnostics(error);
  const embedding = operationEmbeddingDiagnostics(error);
  if (error instanceof MemoryArenaPublicError) {
    return {
      errorCode: error.code,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
      ...(retrieval === undefined ? {} : { retrieval }),
      ...(embedding === undefined ? {} : { embedding }),
    };
  }
  return {
    errorCode: "internal_error",
    retryable: false,
    httpStatus: 500,
    ...(retrieval === undefined ? {} : { retrieval }),
    ...(embedding === undefined ? {} : { embedding }),
  };
}

function operationEmbeddingDiagnostics(
  error: unknown,
): MemoryArenaOperationEmbeddingAudit | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (
      current instanceof MemoryArenaPublicError ||
      current instanceof MemoryArenaOperationDiagnosticError
    ) {
      if (current.diagnostics !== undefined) {
        return current.diagnostics.embedding;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function operationAuditUnavailable(
  error: unknown,
  embedding?: MemoryArenaOperationEmbeddingAudit,
): MemoryArenaPublicError {
  if (
    error instanceof MemoryArenaPublicError &&
    error.code === "artifact_unavailable" &&
    (embedding === undefined || error.diagnostics !== undefined)
  ) {
    return error;
  }
  return new MemoryArenaPublicError({
    code: "artifact_unavailable",
    message: "MemoryArena operation audit could not be persisted",
    httpStatus: 503,
    retryable: true,
    cause: error,
    ...(embedding === undefined ? {} : { diagnostics: { embedding } }),
  });
}

function cloneRetrieval(
  retrieval: MemoryArenaRetrievalResult,
): MemoryArenaRetrievalResult {
  return {
    ...retrieval,
    citations: retrieval.citations.map((citation) => ({ ...citation })),
    evidence: retrieval.evidence.map((item) => ({
      ...item,
      excerpts: item.excerpts.map((excerpt) => ({ ...excerpt })),
      metadata: structuredClone(item.metadata),
    })),
    trace: [...retrieval.trace],
    usage: {
      ...retrieval.usage,
      cost: { ...retrieval.usage.cost },
    },
    ...(retrieval.retrievalModel === undefined
      ? {}
      : {
          retrievalModel: {
            ...retrieval.retrievalModel,
            responseModels: [...retrieval.retrievalModel.responseModels],
          },
        }),
    ...(retrieval.inventory === undefined
      ? {}
      : {
          inventory: retrieval.inventory.map((item) => ({
            item: item.item,
            memoryIds: [...item.memoryIds],
          })),
        }),
    ...(retrieval.audit === undefined
      ? {}
      : { audit: { ...retrieval.audit } }),
    ...(retrieval.operatorExperiment === undefined
      ? {}
      : { operatorExperiment: structuredClone(retrieval.operatorExperiment) }),
  };
}

function sourceIntegrityError(message: string): MemoryArenaPublicError {
  return new MemoryArenaPublicError({
    code: "source_integrity_error",
    message,
    httpStatus: 500,
  });
}

function validateCommittedEvidence(
  retrieval: MemoryArenaRetrievalResult,
): MemoryArenaCommittedEvidence[] {
  if (retrieval.evidenceSummary !== undefined && !retrieval.evidenceSummary.trim()) {
    throw sourceIntegrityError("Picorer retrieval supplied an empty evidence summary");
  }
  if (retrieval.status === "sufficient" && retrieval.evidence.length === 0) {
    throw sourceIntegrityError(
      "Picorer marked retrieval sufficient without committed exact evidence",
    );
  }

  const byId = new Map<string, MemoryArenaCommittedEvidence>();
  for (const source of retrieval.evidence) {
    if (!source.memoryId.trim() || byId.has(source.memoryId)) {
      throw sourceIntegrityError(
        `Picorer returned invalid or duplicate evidence source: ${source.memoryId}`,
      );
    }
    if (
      !Number.isSafeInteger(source.sourceContentLength) ||
      source.sourceContentLength < 0 ||
      !/^[a-f0-9]{64}$/u.test(source.sourceContentHash) ||
      sha256(source.content) !== source.contentHash ||
      source.excerpts.length === 0
    ) {
      throw sourceIntegrityError(
        `Picorer returned invalid exact evidence provenance: ${source.memoryId}`,
      );
    }
    let previousEnd = -1;
    for (const excerpt of source.excerpts) {
      if (
        !Number.isSafeInteger(excerpt.start) ||
        !Number.isSafeInteger(excerpt.end) ||
        excerpt.start < 0 ||
        excerpt.end < excerpt.start ||
        excerpt.end > source.sourceContentLength ||
        excerpt.start < previousEnd ||
        excerpt.content.length !== excerpt.end - excerpt.start
      ) {
        throw sourceIntegrityError(
          `Picorer returned invalid exact evidence offsets: ${source.memoryId}`,
        );
      }
      previousEnd = excerpt.end;
    }
    if (source.content !== renderEvidenceExcerpts({
      sourceContentLength: source.sourceContentLength,
      excerpts: source.excerpts,
    })) {
      throw sourceIntegrityError(
        `Picorer returned evidence content inconsistent with its excerpts: ${source.memoryId}`,
      );
    }
    byId.set(source.memoryId, source);
  }

  const referencedIds = [
    ...retrieval.citations.map((citation) => citation.memoryId),
    ...(retrieval.inventory ?? []).flatMap((item) => item.memoryIds),
  ];
  const missing = [...new Set(referencedIds)].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw sourceIntegrityError(
      `Picorer selected evidence without exact committed passages: ${missing.join(", ")}`,
    );
  }
  const citationIds = new Set(
    retrieval.citations.map((citation) => citation.memoryId),
  );
  if (
    citationIds.size !== retrieval.citations.length ||
    byId.size !== citationIds.size ||
    [...byId.keys()].some((memoryId) => !citationIds.has(memoryId))
  ) {
    throw sourceIntegrityError(
      "Picorer exact read package and harness-generated citations do not match",
    );
  }
  return retrieval.evidence;
}

export function renderMemoryArenaPublicPrompt(
  question: string,
  chunks: readonly string[],
): string {
  return [
    "<memory_context>",
    ...(chunks.length === 0
      ? ["None"]
      : chunks.map((chunk) => `<memory>${chunk}</memory>`)),
    "</memory_context>",
    `User: ${question}`,
  ].join("\n");
}

function renderCommittedMemory(source: MemoryArenaCommittedEvidence): string {
  return [
    "<memory>",
    `memory_id: ${source.memoryId}`,
    `session_id: ${source.sessionId}`,
    `turn_index: ${String(source.turnIndex)}`,
    `role: ${source.role}`,
    `timestamp: ${source.timestamp ?? "unknown"}`,
    "content:",
    source.content,
    "</memory>",
  ].join("\n");
}

export const MEMORYARENA_ANSWER_HANDOFF_ID = "evidence-aware-v1";
export const MEMORYARENA_FULL_PARENT_HANDOFF_MAX_UTF8_BYTES = 128 * 1024;
export const MEMORYARENA_ANSWER_PROMPT_VERSION =
  "memoryarena-public-budgeted-full-parent-no-summary-no-status-20260831-v3";

function renderMemoryArenaEvidenceSources(
  question: string,
  retrieval: MemoryArenaRetrievalResult,
  contentByMemoryId?: ReadonlyMap<string, string>,
): string {
  return [
    `<retrieval_package selected_sources="${String(retrieval.evidence.length)}">`,
    "</retrieval_package>",
    '<memory_context authority="read_exact_sources">',
    ...(retrieval.evidence.length === 0
      ? ["None"]
      : retrieval.evidence.map((source) => renderCommittedMemory(
          contentByMemoryId?.has(source.memoryId)
            ? { ...source, content: contentByMemoryId.get(source.memoryId)! }
            : source,
        ))),
    "</memory_context>",
    `User: ${question}`,
  ].join("\n");
}

/**
 * Evidence-aware answer handoff used by agentic-memory harnesses. Free-text
 * retrieval summary and sufficiency status remain available in result/audit
 * data but are intentionally omitted here. Selected immutable parents are
 * expanded as one all-or-nothing package when the complete prompt fits the
 * full-parent expansion budget; otherwise the exact excerpts returned by read
 * remain the answer authority. This threshold must never silently truncate
 * already committed excerpts, even when that package itself is larger.
 */
export function renderMemoryArenaEvidencePrompt(
  question: string,
  retrieval: MemoryArenaRetrievalResult,
  originalContentByMemoryId?: ReadonlyMap<string, string>,
): string {
  const excerptPrompt = renderMemoryArenaEvidenceSources(question, retrieval);
  if (
    originalContentByMemoryId === undefined ||
    retrieval.evidence.some((source) => {
      const parent = originalContentByMemoryId.get(source.memoryId);
      return parent === undefined || sha256(parent) !== source.sourceContentHash ||
        source.excerpts.some((excerpt) =>
          parent.slice(excerpt.start, excerpt.end) !== excerpt.content
        );
    })
  ) {
    return excerptPrompt;
  }
  const fullParentPrompt = renderMemoryArenaEvidenceSources(
    question,
    retrieval,
    originalContentByMemoryId,
  );
  return new TextEncoder().encode(fullParentPrompt).byteLength <=
      MEMORYARENA_FULL_PARENT_HANDOFF_MAX_UTF8_BYTES
    ? fullParentPrompt
    : excerptPrompt;
}

export class MemoryArenaPublicMemoryBackend {
  constructor(private readonly dependencies: MemoryArenaPublicBackendDependencies) {
    if (!dependencies.memorySystemName.trim()) {
      throw new Error("MemoryArena memory system name must not be empty");
    }
  }

  async initialize(
    input: MemoryArenaInitializeInput,
  ): Promise<MemoryArenaInitializeResult> {
    return this.audited({
      operation: "initialize",
      userId: input.userId,
      memorySystemName: input.memorySystemName,
    }, async () => {
      this.assertSupportedSystem(input.memorySystemName);
      const state = await this.dependencies.generations.initialize(
        input.userId,
        input.memorySystemName,
      );
      return {
        result: {
          userId: state.userId,
          memorySystemName: state.memorySystemName,
          generation: state.generation,
        },
        audit: { generation: state.generation },
      };
    });
  }

  async add(input: MemoryArenaAddInput): Promise<MemoryArenaAddResult> {
    const appendIdentity = input.messages === undefined
      ? input.chunk
      : JSON.stringify({ chunk: input.chunk, messages: input.messages });
    return this.audited({
      operation: "add",
      userId: input.userId,
      memorySystemName: input.memorySystemName,
      chunkSha256: sha256(appendIdentity),
    }, async () => {
      const state = await this.activeState(input);
      const ordinal = await this.dependencies.generations.reserveAppend({
        userId: input.userId,
        generation: state.generation,
        chunk: appendIdentity,
      });
      await this.dependencies.chunks.appendOriginalChunk({
        userId: input.userId,
        generation: state.generation,
        ordinal,
        chunk: input.chunk,
        ...(input.messages === undefined ? {} : { messages: input.messages }),
      });
      const completed = await this.dependencies.generations.completeAppend({
        userId: input.userId,
        generation: state.generation,
        ordinal,
        chunk: appendIdentity,
      });
      return {
        result: { userId: input.userId, response: null },
        audit: {
          generation: completed.generation,
          ordinal,
          nextOrdinal: completed.nextOrdinal,
        },
      };
    });
  }

  async wrap(input: MemoryArenaWrapInput): Promise<MemoryArenaWrapResult> {
    return this.audited({
      operation: "wrap_user_prompt",
      userId: input.userId,
      memorySystemName: input.memorySystemName,
      questionSha256: sha256(input.question),
    }, async () => {
      const state = await this.activeState(input);
      if (state.pendingAppend !== undefined) {
        throw new MemoryArenaPublicError({
          code: "append_pending",
          message: `Memory append ${state.pendingAppend.ordinal} is incomplete`,
          httpStatus: 503,
          retryable: true,
        });
      }

      let retrieval: MemoryArenaRetrievalResult | undefined;
      let ids: string[] = [];
      let chunks: string[] = [];
      let originalContentByMemoryId: ReadonlyMap<string, string> | undefined;
      if (state.nextOrdinal > 0) {
        retrieval = await this.dependencies.retriever.retrieve({
          userId: state.userId,
          generation: state.generation,
          question: input.question,
          ...(input.operatorExperiment === undefined
            ? {}
            : { operatorExperiment: input.operatorExperiment }),
        });
        const evidence = validateCommittedEvidence(retrieval);
        ids = evidence.map((source) => source.memoryId);
        if (ids.length > 0) {
          const originals = await this.dependencies.chunks.readOriginalChunks({
            userId: state.userId,
            generation: state.generation,
            memoryIds: ids,
          });
          const byId = new Map(
            originals.map((chunk) => [chunk.memoryId, chunk.content]),
          );
          originalContentByMemoryId = byId;
          const missing = ids.filter((memoryId) => !byId.has(memoryId));
          if (missing.length > 0) {
            throw sourceIntegrityError(
              `Picorer selected missing source chunks: ${missing.join(", ")}`,
            );
          }
          chunks = evidence.map((source) => {
            const content = byId.get(source.memoryId)!;
            if (
              content.length !== source.sourceContentLength ||
              sha256(content) !== source.sourceContentHash
            ) {
              throw sourceIntegrityError(
                `Picorer selected a source changed after retrieval: ${source.memoryId}`,
              );
            }
            return content;
          });
        }
      }

      const prompt = input.answerHandoff === "evidence-aware-v1" && retrieval !== undefined
        ? renderMemoryArenaEvidencePrompt(
            input.question,
            retrieval,
            originalContentByMemoryId,
          )
        : renderMemoryArenaPublicPrompt(input.question, chunks);
      try {
        await this.dependencies.audits.record({
          schemaVersion: 1,
          userId: state.userId,
          memorySystemName: state.memorySystemName,
          generation: state.generation,
          nextOrdinal: state.nextOrdinal,
          question: input.question,
          prompt,
          selectedMemoryIds: ids,
          ...(retrieval === undefined
            ? {}
            : { retrieval: cloneRetrieval(retrieval) }),
          ...(retrieval?.operatorExperiment === undefined
            ? {}
            : {
                operatorExperiment: structuredClone(
                  retrieval.operatorExperiment,
                ),
              }),
        });
      } catch (error) {
        if (error instanceof MemoryArenaPublicError) throw error;
        throw new MemoryArenaPublicError({
          code: "artifact_unavailable",
          message: "MemoryArena wrap audit could not be persisted",
          httpStatus: 503,
          retryable: true,
          cause: error,
        });
      }
      return {
        result: {
          userId: state.userId,
          prompt,
          ...(retrieval?.retrievalModel === undefined
            ? {}
            : {
                retrievalModel: {
                  ...retrieval.retrievalModel,
                  responseModels: [...retrieval.retrievalModel.responseModels],
                },
              }),
          ...(retrieval?.operatorExperiment === undefined
            ? {}
            : {
                operatorExperiment: structuredClone(
                  retrieval.operatorExperiment,
                ),
              }),
        },
        audit: {
          generation: state.generation,
          nextOrdinal: state.nextOrdinal,
          ...(retrieval === undefined
            ? {}
            : {
                retrieval: {
                  runId: retrieval.runId,
                  status: retrieval.status,
                  usage: {
                    ...retrieval.usage,
                    cost: { ...retrieval.usage.cost },
                  },
                },
              }),
        },
      };
    });
  }

  private async audited<T>(
    start: MemoryArenaOperationAuditStart,
    operation: () => Promise<{
      result: T;
      audit: MemoryArenaOperationAuditSuccess;
    }>,
  ): Promise<T> {
    let span: MemoryArenaOperationAuditSpan;
    try {
      span = await this.dependencies.operationAudits.begin(start);
    } catch (error) {
      throw operationAuditUnavailable(error);
    }

    let outcome: { result: T; audit: MemoryArenaOperationAuditSuccess };
    try {
      if (start.operation === "initialize") {
        outcome = await operation();
      } else {
        const measured = await this.dependencies.embeddingMeter.measureOperation(
          operation,
        );
        outcome = {
          result: measured.result.result,
          audit: {
            ...measured.result.audit,
            embedding: measured.embedding,
          },
        };
      }
    } catch (error) {
      try {
        await span.fail(operationFailure(error));
      } catch (auditError) {
        throw operationAuditUnavailable(auditError);
      }
      throw error;
    }

    try {
      await span.succeed(outcome.audit);
    } catch (error) {
      const unavailable = operationAuditUnavailable(error, outcome.audit.embedding);
      try {
        await span.fail(operationFailure(unavailable));
      } catch {
        // The primary failure is that the durable audit is unavailable.
      }
      throw unavailable;
    }
    return outcome.result;
  }

  private assertSupportedSystem(memorySystemName: string): void {
    if (memorySystemName !== this.dependencies.memorySystemName) {
      throw unsupportedMemorySystem(memorySystemName);
    }
  }

  private async activeState(
    input: MemoryArenaInitializeInput,
  ): Promise<MemoryArenaGenerationState> {
    const state = await this.dependencies.generations.get(input.userId);
    if (state === undefined) throw userNotInitialized();
    if (state.memorySystemName !== input.memorySystemName) {
      throw memorySystemMismatch();
    }
    return state;
  }
}
