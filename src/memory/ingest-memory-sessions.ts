import type {
  MemoryRecord,
  MemoryRole,
  MemorySessionInput,
  ScopeIngestStatus,
} from "./model/memory.js";
import type { MemoryIngestStore } from "./ports/memory-ingest-store.js";
import { assertNonEmpty, sha256, stableMemoryId } from "../util.js";

const ROLES = new Set<MemoryRole>([
  "user",
  "assistant",
  "system",
  "other",
]);

const ISO_LOCAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/u;

export interface IngestOptions {
  exportRoot?: string;
}

export interface IngestScopeResult {
  scopeId: string;
  status: ScopeIngestStatus;
  memoryCount: number;
  exportPath?: string;
}

function assertSafeJson(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain finite JSON numbers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain JSON-compatible values`);
  }

  for (const [key, child] of Object.entries(value)) {
    assertSafeJson(child, `${path}.${key}`);
  }
}

function cloneMetadata(
  value: Record<string, unknown> | undefined,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    throw new Error(`${path} must be an object`);
  }
  assertSafeJson(value, path);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function validateTimestamp(
  value: string | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = assertNonEmpty(value, path);
  if (!ISO_LOCAL_TIMESTAMP.test(timestamp)) {
    throw new Error(`${path} must be a normalized ISO-8601 timestamp`);
  }
  return timestamp;
}

function recordsForScope(
  scopeId: string,
  sessions: readonly MemorySessionInput[],
): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const seenSessions = new Set<string>();
  const seenMemories = new Set<string>();

  for (const [sessionIndex, session] of sessions.entries()) {
    if (session.scopeId !== scopeId) {
      throw new Error(`Session belongs to the wrong scope at index ${sessionIndex}`);
    }
    const sessionId = assertNonEmpty(
      session.sessionId,
      `sessions[${sessionIndex}].sessionId`,
    );
    if (seenSessions.has(sessionId)) {
      throw new Error(`Duplicate session ID in scope ${scopeId}: ${sessionId}`);
    }
    seenSessions.add(sessionId);
    if (!Array.isArray(session.turns) || session.turns.length === 0) {
      throw new Error(`Session must contain at least one turn: ${sessionId}`);
    }

    const timestamp = validateTimestamp(
      session.timestamp,
      `sessions[${sessionIndex}].timestamp`,
    );
    const sessionMetadata = cloneMetadata(
      session.metadata,
      `sessions[${sessionIndex}].metadata`,
    );

    for (const [turnIndex, turn] of session.turns.entries()) {
      if (!ROLES.has(turn.role)) {
        throw new Error(
          `Invalid role at ${sessionId}.turns[${turnIndex}]: ${String(turn.role)}`,
        );
      }
      if (typeof turn.content !== "string") {
        throw new Error(`${sessionId}.turns[${turnIndex}].content must be a string`);
      }
      const sourceId =
        turn.id === undefined
          ? undefined
          : assertNonEmpty(turn.id, `${sessionId}.turns[${turnIndex}].id`);
      const memoryId =
        sourceId ??
        stableMemoryId(scopeId, sessionId, turnIndex);
      if (seenMemories.has(memoryId)) {
        throw new Error(`Duplicate memory ID in scope ${scopeId}: ${memoryId}`);
      }
      seenMemories.add(memoryId);

      const turnMetadata = cloneMetadata(
        turn.metadata,
        `${sessionId}.turns[${turnIndex}].metadata`,
      );
      const metadata: Record<string, unknown> = {};
      if (sessionMetadata !== undefined) metadata.session = sessionMetadata;
      if (turnMetadata !== undefined) metadata.turn = turnMetadata;

      const base: MemoryRecord = {
        memoryId,
        scopeId,
        sessionId,
        turnIndex,
        role: turn.role,
        content: turn.content,
        contentHash: sha256(turn.content),
        metadata,
      };
      records.push(timestamp === undefined ? base : { ...base, timestamp });
    }
  }

  return records;
}

/**
 * Deterministic, no-LLM ingest boundary.
 *
 * This function only validates, hashes, indexes and exports source records.
 * It has no model/runtime dependency and cannot summarize or rewrite content.
 */
export async function ingestMemorySessions(
  store: MemoryIngestStore,
  sessions: readonly MemorySessionInput[],
  options: IngestOptions = {},
): Promise<IngestScopeResult[]> {
  if (sessions.length === 0) {
    throw new Error("At least one sanitized memory session is required");
  }

  const byScope = new Map<string, MemorySessionInput[]>();
  for (const [index, session] of sessions.entries()) {
    const scopeId = assertNonEmpty(session.scopeId, `sessions[${index}].scopeId`);
    const bucket = byScope.get(scopeId) ?? [];
    bucket.push(session);
    byScope.set(scopeId, bucket);
  }

  const results: IngestScopeResult[] = [];
  for (const [scopeId, scopeSessions] of byScope) {
    const records = recordsForScope(scopeId, scopeSessions);
    const status = store.ingestScope(scopeId, records);
    const scopeExport =
      options.exportRoot === undefined
        ? undefined
        : await store.exportScope(scopeId, options.exportRoot);
    results.push({
      scopeId,
      status,
      memoryCount: records.length,
      ...(scopeExport === undefined ? {} : { exportPath: scopeExport.path }),
    });
  }
  return results;
}
