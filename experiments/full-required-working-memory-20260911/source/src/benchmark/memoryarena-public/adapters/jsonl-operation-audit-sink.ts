import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryArenaPublicError,
  type MemoryArenaEmbeddingMetrics,
  type MemoryArenaOperationAuditFailure,
  type MemoryArenaOperationEmbeddingAudit,
  type MemoryArenaOperationAuditStart,
  type MemoryArenaOperationAuditSuccess,
} from "../model/memory-backend.js";
import type {
  MemoryArenaOperationAuditSink,
  MemoryArenaOperationAuditSpan,
} from "../ports/memory-backend.js";

type AuditPhase = "start" | "success" | "failure";

function embeddingMetrics(
  metrics: MemoryArenaEmbeddingMetrics,
): Record<string, number> {
  return {
    calls: metrics.calls,
    latency_ms: metrics.latencyMs,
    input_tokens: metrics.inputTokens,
    usage_missing_calls: metrics.usageMissingCalls,
  };
}

function embeddingAudit(
  audit: MemoryArenaOperationEmbeddingAudit,
): Record<string, unknown> {
  return {
    measurement: audit.measurement,
    delta: embeddingMetrics(audit.delta),
  };
}

function artifactUnavailable(cause: unknown): MemoryArenaPublicError {
  return new MemoryArenaPublicError({
    code: "artifact_unavailable",
    message: "MemoryArena operation audit could not be persisted",
    httpStatus: 503,
    retryable: true,
    cause,
  });
}

/**
 * Durable, privacy-safe lifecycle log for the official initialize/add/wrap API.
 *
 * One process owns the containing data directory. Within that process every
 * append is serialized and fsynced before the benchmark operation continues.
 */
export class JsonlMemoryArenaOperationAuditSink
implements MemoryArenaOperationAuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async begin(
    record: MemoryArenaOperationAuditStart,
  ): Promise<MemoryArenaOperationAuditSpan> {
    const operationId = randomUUID();
    const base = {
      schema_version: 1,
      operation_id: operationId,
      operation: record.operation,
      user_id: record.userId,
      memory_system_name: record.memorySystemName,
      ...(record.questionSha256 === undefined
        ? {}
        : { question_sha256: record.questionSha256 }),
      ...(record.chunkSha256 === undefined
        ? {}
        : { chunk_sha256: record.chunkSha256 }),
    };
    await this.append({
      ...base,
      phase: "start" satisfies AuditPhase,
      status: "started",
    });

    let terminal = false;
    const finish = async (
      phase: Exclude<AuditPhase, "start">,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      if (terminal) {
        throw new Error(`MemoryArena operation ${operationId} is already terminal`);
      }
      await this.append({
        ...base,
        phase,
        status: phase === "success" ? "ok" : "error",
        ...payload,
      });
      terminal = true;
    };

    return {
      succeed: (result: MemoryArenaOperationAuditSuccess) => finish("success", {
        ...(result.generation === undefined
          ? {}
          : { generation: result.generation }),
        ...(result.ordinal === undefined ? {} : { ordinal: result.ordinal }),
        ...(result.nextOrdinal === undefined
          ? {}
          : { next_ordinal: result.nextOrdinal }),
        ...(result.retrieval === undefined
          ? {}
          : {
              retrieval: {
                run_id: result.retrieval.runId,
                status: result.retrieval.status,
                usage: result.retrieval.usage,
              },
            }),
        ...(result.embedding === undefined
          ? {}
          : { embedding: embeddingAudit(result.embedding) }),
      }),
      fail: (failure: MemoryArenaOperationAuditFailure) => finish("failure", {
        error_code: failure.errorCode,
        retryable: failure.retryable,
        status_code: failure.httpStatus,
        ...(failure.retrieval === undefined
          ? {}
          : {
              retrieval: {
                run_id: failure.retrieval.runId,
                turns: failure.retrieval.turns,
                tool_calls: failure.retrieval.toolCalls,
                candidate_count: failure.retrieval.candidateCount,
                evidence_count: failure.retrieval.evidenceCount,
                trace: {
                  entries: failure.retrieval.trace.entries,
                  error_entries: failure.retrieval.trace.errorEntries,
                  by_tool: failure.retrieval.trace.byTool,
                },
                usage: failure.retrieval.usage,
              },
            }),
        ...(failure.embedding === undefined
          ? {}
          : { embedding: embeddingAudit(failure.embedding) }),
      }),
    };
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private append(record: Record<string, unknown>): Promise<void> {
    const operation = this.tail.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const handle = await open(this.path, "a", 0o600);
      try {
        const envelope = {
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          ...record,
        };
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.path, 0o600);
    });
    this.tail = operation.catch(() => undefined);
    return operation.catch((error: unknown) => {
      throw artifactUnavailable(error);
    });
  }
}
