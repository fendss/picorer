import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { exportMemoryScope } from "../filesystem/export-memory-scope.js";
import { DatabaseSync } from "node:sqlite";
import { DatabaseEvidenceOperators } from "../../retrieval/adapters/sqlite/database-evidence-operators.js";
import type { EvidenceFactIndexStatus } from "../../retrieval/adapters/sqlite/evidence-fact-index.js";
import type {
  EvidenceOperatorSearchContext,
  RetrievalHit,
  SearchRequest,
} from "../../retrieval/index.js";
import type {
  AppendMemoryRequest,
  AppendMemoryResult,
  MemoryRecord,
  OnlineScopeState,
  ScopeExport,
  ScopeIngestStatus,
} from "../../memory/index.js";
import type {
  MemoryIngestStore,
  OnlineMemoryStore,
} from "../../memory/ports/memory-ingest-store.js";
import type {
  EmbeddingIndexStatus,
  EmbeddingProfile,
  StoredEmbeddingRecord,
  StoreEmbeddingBatchResult,
  VectorIndexGenerationConfig,
  VectorIndexGenerationState,
  VectorIndexGenerationStatus,
  VectorSyncClaim,
} from "../../retrieval/model/embedding.js";
import {
  sha256,
  stableMemoryId,
} from "../../util.js";
import {
  type MemoryRow,
  memoryRowToRecord,
} from "./memory-row.js";
import {
  decodeFloat32Vector,
  encodeFloat32Vector,
  equalBytes,
} from "./float32-vector.js";
import { SqliteVectorIndexStateStore } from "./vector-index-state-store.js";
import { SqliteLexicalRetriever } from "../../retrieval/adapters/sqlite/lexical-retriever.js";
import type { HybridSearchStore } from "../../retrieval/ports/hybrid-search-store.js";
import type { VectorIndexStateStore } from "../../retrieval/ports/vector-index-state-store.js";

interface EmbeddingRow extends MemoryRow {
  vector: Uint8Array;
}

interface ExistingEmbeddingRow {
  model: string;
  dimensions: number;
  content_hash: string;
  vector: Uint8Array;
}

interface AppendRequestRow {
  request_hash: string;
  scope_id: string;
  source_session_id: string;
  session_id: string;
  start_turn_index: number;
  message_count: number;
  complete: number;
}

export type {
  EmbeddingIndexStatus,
  EmbeddingProfile,
  StoredEmbeddingRecord,
  StoreEmbeddingBatchResult,
  VectorIndexGenerationConfig,
  VectorIndexGenerationState,
  VectorIndexGenerationStatus,
  VectorSyncClaim,
};
export type StoreSearchHit = RetrievalHit;

export type { ScopeExport, ScopeIngestStatus };

function compareRecords(a: MemoryRecord, b: MemoryRecord): number {
  if (a.timestamp !== b.timestamp) {
    if (a.timestamp === undefined) return 1;
    if (b.timestamp === undefined) return -1;
    const time = a.timestamp.localeCompare(b.timestamp);
    if (time !== 0) return time;
  }
  const session = a.sessionId.localeCompare(b.sessionId);
  return session !== 0 ? session : a.turnIndex - b.turnIndex;
}

function recordFingerprint(record: MemoryRecord): string {
  return JSON.stringify([
    record.memoryId,
    record.scopeId,
    record.sessionId,
    record.turnIndex,
    record.role,
    record.content,
    record.timestamp ?? null,
    record.contentHash,
    record.metadata,
  ]);
}

function validateEmbeddingProfile(profile: EmbeddingProfile): void {
  if (!profile.profileId.trim()) throw new Error("Embedding profile ID must not be empty");
  if (!profile.model.trim()) throw new Error("Embedding model must not be empty");
  if (!Number.isSafeInteger(profile.dimensions) || profile.dimensions <= 0) {
    throw new Error("Embedding dimensions must be a positive integer");
  }
}

export class MemoryStore implements
  MemoryIngestStore,
  OnlineMemoryStore,
  HybridSearchStore,
  VectorIndexStateStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly evidenceOperators: DatabaseEvidenceOperators;
  private readonly lexicalRetriever: SqliteLexicalRetriever;
  private readonly vectorIndex: SqliteVectorIndexStateStore;
  private readonly validatedEmbeddingProfiles = new Map<string, string>();
  private readonly completeEmbeddingStatuses = new Map<
    string,
    EmbeddingIndexStatus
  >();

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL UNIQUE,
        scope_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope_session_turn
        ON memories(scope_id, session_id, turn_index);
      CREATE INDEX IF NOT EXISTS memories_scope_timestamp
        ON memories(scope_id, timestamp);
      CREATE INDEX IF NOT EXISTS memories_scope_memory
        ON memories(scope_id, memory_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        scope_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (memory_id, profile_id),
        FOREIGN KEY (memory_id) REFERENCES memories(memory_id)
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_profile
        ON memory_embeddings(profile_id, memory_id);
      CREATE TABLE IF NOT EXISTS online_memory_scopes (
        scope_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('ingesting', 'sealed')),
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_append_sessions (
        scope_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        next_turn_index INTEGER NOT NULL,
        PRIMARY KEY (scope_id, source_session_id),
        UNIQUE (scope_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS memory_append_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        start_turn_index INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS memory_append_requests_scope
        ON memory_append_requests(scope_id, request_id);
    `);
    this.evidenceOperators = new DatabaseEvidenceOperators(this.db);
    this.lexicalRetriever = new SqliteLexicalRetriever(this.db);
    this.vectorIndex = new SqliteVectorIndexStateStore(
      this.db,
      (scopeId, profile) => this.getEmbeddingIndexStatus(scopeId, profile),
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Inserts one immutable source scope.
   *
   * Re-ingesting byte-identical records is a no-op. A caller must use a new
   * scope/version when any source record changes; existing raw memory is never
   * silently deleted or overwritten.
   */
  ingestScope(
    scopeId: string,
    records: MemoryRecord[],
  ): ScopeIngestStatus {
    if (records.length === 0) {
      throw new Error(`Cannot ingest empty memory scope: ${scopeId}`);
    }
    if (records.some((record) => record.scopeId !== scopeId)) {
      throw new Error(`Every memory record must belong to scope ${scopeId}`);
    }
    if (
      new Set(records.map((record) => record.memoryId)).size !== records.length
    ) {
      throw new Error(`Duplicate memory ID in scope ${scopeId}`);
    }

    const existing = this.listScopeRecords(scopeId);
    if (existing.length > 0) {
      const current = existing.map(recordFingerprint).sort();
      const incoming = records.map(recordFingerprint).sort();
      if (
        current.length === incoming.length &&
        current.every((fingerprint, index) => fingerprint === incoming[index])
      ) {
        return "unchanged";
      }
      throw new Error(
        `Immutable memory scope already exists with different content: ${scopeId}`,
      );
    }

    const insertRecord = this.db.prepare(`
      INSERT INTO memories (
        memory_id, scope_id, session_id, turn_index, role, content,
        timestamp, content_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO memory_fts(memory_id, scope_id, content)
      VALUES (?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        insertRecord.run(
          record.memoryId,
          record.scopeId,
          record.sessionId,
          record.turnIndex,
          record.role,
          record.content,
          record.timestamp ?? null,
          record.contentHash,
          JSON.stringify(record.metadata),
        );
        insertFts.run(
          record.memoryId,
          record.scopeId,
          `${record.role}: ${record.content}`,
        );
      }
      this.db.exec("COMMIT");
      return "inserted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Appends immutable source messages while the online scope is ingesting. */
  appendMemoryRequest(request: AppendMemoryRequest): AppendMemoryResult {
    if (request.messages.length === 0) {
      throw new Error("Append request must contain at least one message");
    }
    const existing = this.db.prepare(`
      SELECT request_hash, scope_id, source_session_id, session_id,
             start_turn_index, message_count, complete
      FROM memory_append_requests WHERE request_id = ?
    `).get(request.requestId) as unknown as AppendRequestRow | undefined;
    if (existing) {
      if (
        existing.request_hash !== request.requestHash ||
        existing.scope_id !== request.scopeId ||
        existing.source_session_id !== request.sourceSessionId ||
        existing.message_count !== request.messages.length
      ) {
        throw new Error(`Append request ID conflict: ${request.requestId}`);
      }
      return {
        status: existing.complete === 1 ? "complete" : "pending",
        records: this.recordsInTurnRange(
          request.scopeId,
          existing.session_id,
          existing.start_turn_index,
          existing.message_count,
        ),
      };
    }

    const sessionId = `s-${sha256(`${request.scopeId}\0${request.sourceSessionId}`).slice(0, 24)}`;
    const getSession = this.db.prepare(`
      SELECT session_id, next_turn_index FROM memory_append_sessions
      WHERE scope_id = ? AND source_session_id = ?
    `);
    const insertScope = this.db.prepare(`
      INSERT INTO online_memory_scopes (scope_id, state, updated_at_ms)
      VALUES (?, 'ingesting', ?)
      ON CONFLICT(scope_id) DO NOTHING
    `);
    const getScope = this.db.prepare(`
      SELECT state FROM online_memory_scopes WHERE scope_id = ?
    `);
    const insertSession = this.db.prepare(`
      INSERT INTO memory_append_sessions (
        scope_id, source_session_id, session_id, next_turn_index
      ) VALUES (?, ?, ?, 0)
    `);
    const updateSession = this.db.prepare(`
      UPDATE memory_append_sessions SET next_turn_index = ?
      WHERE scope_id = ? AND source_session_id = ?
    `);
    const insertRequest = this.db.prepare(`
      INSERT INTO memory_append_requests (
        request_id, request_hash, scope_id, source_session_id, session_id,
        start_turn_index, message_count, complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const insertRecord = this.db.prepare(`
      INSERT INTO memories (
        memory_id, scope_id, session_id, turn_index, role, content,
        timestamp, content_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO memory_fts(memory_id, scope_id, content) VALUES (?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      insertScope.run(request.scopeId, Date.now());
      const scope = getScope.get(request.scopeId) as unknown as
        | { state: OnlineScopeState }
        | undefined;
      if (scope?.state !== "ingesting") {
        throw new Error(`Online memory scope is sealed: ${request.scopeId}`);
      }
      let session = getSession.get(
        request.scopeId,
        request.sourceSessionId,
      ) as unknown as { session_id: string; next_turn_index: number } | undefined;
      if (!session) {
        insertSession.run(request.scopeId, request.sourceSessionId, sessionId);
        session = { session_id: sessionId, next_turn_index: 0 };
      }
      if (session.session_id !== sessionId) {
        throw new Error(`Append session identity conflict: ${request.sourceSessionId}`);
      }
      const startTurnIndex = session.next_turn_index;
      const records = request.messages.map((message, messageIndex): MemoryRecord => {
        const turnIndex = startTurnIndex + messageIndex;
        return {
          memoryId: stableMemoryId(request.scopeId, sessionId, turnIndex),
          scopeId: request.scopeId,
          sessionId,
          turnIndex,
          role: message.role,
          content: message.content,
          contentHash: sha256(message.content),
          metadata: {
            session: { sourceSessionId: request.sourceSessionId },
            turn: { sourceMessageIndex: messageIndex },
          },
          ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        };
      });
      for (const record of records) {
        insertRecord.run(
          record.memoryId,
          record.scopeId,
          record.sessionId,
          record.turnIndex,
          record.role,
          record.content,
          record.timestamp ?? null,
          record.contentHash,
          JSON.stringify(record.metadata),
        );
        insertFts.run(record.memoryId, record.scopeId, `${record.role}: ${record.content}`);
      }
      insertRequest.run(
        request.requestId,
        request.requestHash,
        request.scopeId,
        request.sourceSessionId,
        sessionId,
        startTurnIndex,
        records.length,
      );
      updateSession.run(
        startTurnIndex + records.length,
        request.scopeId,
        request.sourceSessionId,
      );
      this.db.exec("COMMIT");
      this.completeEmbeddingStatuses.clear();
      return { status: "pending", records };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasPendingAppendRequests(scopeId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM memory_append_requests
      WHERE scope_id = ? AND complete = 0 LIMIT 1
    `).get(scopeId) !== undefined;
  }

  markAppendRequestComplete(requestId: string, requestHash: string): void {
    const result = this.db.prepare(`
      UPDATE memory_append_requests SET complete = 1
      WHERE request_id = ? AND request_hash = ?
    `).run(requestId, requestHash);
    if (result.changes !== 1) {
      throw new Error(`Cannot complete unknown append request: ${requestId}`);
    }
  }

  getOnlineScopeState(scopeId: string): OnlineScopeState | undefined {
    const row = this.db.prepare(`
      SELECT state FROM online_memory_scopes WHERE scope_id = ?
    `).get(scopeId) as unknown as { state: OnlineScopeState } | undefined;
    return row?.state;
  }

  sealOnlineScope(scopeId: string): OnlineScopeState {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT state FROM online_memory_scopes WHERE scope_id = ?
      `).get(scopeId) as unknown as { state: OnlineScopeState } | undefined;
      if (this.hasPendingAppendRequests(scopeId)) {
        throw new Error(`Memory ingestion is incomplete for scope: ${scopeId}`);
      }
      if (!row) {
        const count = this.db.prepare(`
          SELECT COUNT(*) AS count FROM memories WHERE scope_id = ?
        `).get(scopeId) as unknown as { count: number };
        if (count.count === 0) {
          throw new Error(`No memories have been added for scope: ${scopeId}`);
        }
        // Existing production scopes predate this lifecycle sidecar and are already sealed.
        this.db.prepare(`
          INSERT INTO online_memory_scopes (scope_id, state, updated_at_ms)
          VALUES (?, 'sealed', ?)
        `).run(scopeId, Date.now());
      } else {
        this.db.prepare(`
          UPDATE online_memory_scopes SET state = 'sealed', updated_at_ms = ?
          WHERE scope_id = ?
        `).run(Date.now(), scopeId);
      }
      this.db.exec("COMMIT");
      return "sealed";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recordsInTurnRange(
    scopeId: string,
    sessionId: string,
    startTurnIndex: number,
    count: number,
  ): MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT memory_id, scope_id, session_id, turn_index, role, content,
             timestamp, content_hash, metadata_json
      FROM memories
      WHERE scope_id = ? AND session_id = ?
        AND turn_index >= ? AND turn_index < ?
      ORDER BY turn_index ASC
    `).all(
      scopeId,
      sessionId,
      startTurnIndex,
      startTurnIndex + count,
    ) as unknown as MemoryRow[];
    if (rows.length !== count) {
      throw new Error(`Append request records are incomplete in scope ${scopeId}`);
    }
    return rows.map(memoryRowToRecord);
  }

  /** Builds or validates the deterministic sidecar index for one scope. */
  ensureEvidenceFactIndex(scopeId: string): EvidenceFactIndexStatus {
    return this.evidenceOperators.ensureScope(scopeId);
  }

  /** Expands hybrid/FTS seeds through the versioned database fact index. */
  expandEvidenceOperator(
    scopeId: string,
    request: SearchRequest,
    context: EvidenceOperatorSearchContext,
    seedHits: readonly StoreSearchHit[],
  ): StoreSearchHit[] {
    return this.evidenceOperators.expand(scopeId, request, context, seedHits);
  }

  searchLexical(scopeId: string, request: SearchRequest): StoreSearchHit[] {
    return this.search(scopeId, request);
  }

  search(scopeId: string, request: SearchRequest): StoreSearchHit[] {
    return this.lexicalRetriever.search(scopeId, request);
  }

  read(
    scopeId: string,
    memoryIds: string[],
    contextBefore = 0,
    contextAfter = 0,
  ): MemoryRecord[] {
    const before = Math.min(Math.max(contextBefore, 0), 10);
    const after = Math.min(Math.max(contextAfter, 0), 10);
    const selected = new Map<string, MemoryRecord>();
    const getOne = this.db.prepare(`
      SELECT memory_id, scope_id, session_id, turn_index, role, content,
             timestamp, content_hash, metadata_json
      FROM memories
      WHERE scope_id = ? AND memory_id = ?
    `);
    const getContext = this.db.prepare(`
      SELECT memory_id, scope_id, session_id, turn_index, role, content,
             timestamp, content_hash, metadata_json
      FROM memories
      WHERE scope_id = ? AND session_id = ?
        AND turn_index BETWEEN ? AND ?
      ORDER BY turn_index ASC
    `);

    for (const memoryId of [...new Set(memoryIds)]) {
      const row = getOne.get(scopeId, memoryId) as unknown as
        | MemoryRow
        | undefined;
      if (!row) {
        throw new Error(`Memory not found in scope: ${memoryId}`);
      }
      const contextRows = getContext.all(
        scopeId,
        row.session_id,
        Math.max(0, row.turn_index - before),
        row.turn_index + after,
      ) as unknown as MemoryRow[];
      for (const contextRow of contextRows) {
        const record = memoryRowToRecord(contextRow);
        selected.set(record.memoryId, record);
      }
    }
    return [...selected.values()].sort(compareRecords);
  }

  getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[] {
    if (memoryIds.length === 0) return [];
    const statement = this.db.prepare(`
      SELECT memory_id, scope_id, session_id, turn_index, role, content,
             timestamp, content_hash, metadata_json
      FROM memories
      WHERE scope_id = ? AND memory_id = ?
    `);
    return [...new Set(memoryIds)]
      .map((memoryId) =>
        statement.get(scopeId, memoryId) as unknown as MemoryRow | undefined,
      )
      .filter((row): row is MemoryRow => row !== undefined)
      .map(memoryRowToRecord)
      .sort(compareRecords);
  }

  listScopeRecords(scopeId: string): MemoryRecord[] {
    const rows = this.db
      .prepare(`
        SELECT memory_id, scope_id, session_id, turn_index, role, content,
               timestamp, content_hash, metadata_json
        FROM memories
        WHERE scope_id = ?
        ORDER BY timestamp IS NULL ASC, timestamp ASC,
                 session_id ASC, turn_index ASC
      `)
      .all(scopeId) as unknown as MemoryRow[];
    return rows.map(memoryRowToRecord);
  }

  listScopeIds(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT scope_id FROM memories ORDER BY scope_id ASC
    `).all() as unknown as Array<{ scope_id: string }>;
    return rows.map((row) => row.scope_id);
  }

  private assertEmbeddingProfileConsistent(profile: EmbeddingProfile): void {
    validateEmbeddingProfile(profile);
    const signature = JSON.stringify([profile.model, profile.dimensions]);
    const cached = this.validatedEmbeddingProfiles.get(profile.profileId);
    if (cached !== undefined) {
      if (cached !== signature) {
        throw new Error(`Embedding profile metadata conflict: ${profile.profileId}`);
      }
      return;
    }
    const profileConflict = this.db.prepare(`
      SELECT 1
      FROM memory_embeddings
      WHERE profile_id = ? AND (model <> ? OR dimensions <> ?)
      LIMIT 1
    `).get(
      profile.profileId,
      profile.model,
      profile.dimensions,
    );
    if (profileConflict) {
      throw new Error(`Embedding profile metadata conflict: ${profile.profileId}`);
    }
    this.validatedEmbeddingProfiles.set(profile.profileId, signature);
  }

  getEmbeddingIndexStatus(
    scopeId: string,
    profile: EmbeddingProfile,
  ): EmbeddingIndexStatus {
    this.assertEmbeddingProfileConsistent(profile);
    const cacheKey = JSON.stringify([
      scopeId,
      profile.profileId,
      profile.model,
      profile.dimensions,
    ]);
    const cached = this.completeEmbeddingStatuses.get(cacheKey);
    if (cached !== undefined) return { ...cached };

    // CROSS JOIN keeps SQLite on the selective scope-first lookup path.
    const hashConflict = this.db.prepare(`
      SELECT 1
      FROM memories AS m
      CROSS JOIN memory_embeddings AS e ON e.memory_id = m.memory_id
      WHERE m.scope_id = ? AND e.profile_id = ?
        AND e.content_hash <> m.content_hash
      LIMIT 1
    `).get(scopeId, profile.profileId);
    if (hashConflict) {
      throw new Error(`Embedding content hash conflict in scope ${scopeId}`);
    }
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memories WHERE scope_id = ?
    `).get(scopeId) as unknown as { count: number };
    const indexedRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memories AS m
      CROSS JOIN memory_embeddings AS e ON e.memory_id = m.memory_id
      WHERE m.scope_id = ? AND e.profile_id = ?
        AND e.model = ? AND e.dimensions = ?
        AND e.content_hash = m.content_hash
    `).get(
      scopeId,
      profile.profileId,
      profile.model,
      profile.dimensions,
    ) as unknown as { count: number };
    const status = {
      scopeId,
      profileId: profile.profileId,
      total: totalRow.count,
      indexed: indexedRow.count,
      missing: totalRow.count - indexedRow.count,
    };
    if (status.total > 0 && status.missing === 0) {
      this.completeEmbeddingStatuses.set(cacheKey, status);
    }
    return { ...status };
  }

  listMissingEmbeddingRecords(
    scopeId: string,
    profile: EmbeddingProfile,
  ): MemoryRecord[] {
    this.getEmbeddingIndexStatus(scopeId, profile);
    const rows = this.db.prepare(`
      SELECT m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
             m.content, m.timestamp, m.content_hash, m.metadata_json
      FROM memories AS m
      WHERE m.scope_id = ? AND NOT EXISTS (
        SELECT 1 FROM memory_embeddings AS e
        WHERE e.memory_id = m.memory_id AND e.profile_id = ?
      )
      ORDER BY m.timestamp IS NULL ASC, m.timestamp ASC,
               m.session_id ASC, m.turn_index ASC
    `).all(scopeId, profile.profileId) as unknown as MemoryRow[];
    return rows.map(memoryRowToRecord);
  }

  storeEmbeddingBatch(
    records: readonly MemoryRecord[],
    profile: EmbeddingProfile,
    vectors: readonly (readonly number[])[],
  ): StoreEmbeddingBatchResult {
    this.assertEmbeddingProfileConsistent(profile);
    if (records.length !== vectors.length) {
      throw new Error("Embedding record and vector counts must match");
    }
    if (records.length === 0) return { inserted: 0, unchanged: 0 };
    if (new Set(records.map((record) => record.memoryId)).size !== records.length) {
      throw new Error("Embedding batch contains duplicate memory IDs");
    }
    const scopeId = records[0]!.scopeId;
    if (records.some((record) => record.scopeId !== scopeId)) {
      throw new Error("Embedding batch must contain exactly one scope");
    }

    const getRaw = this.db.prepare(`
      SELECT scope_id, content_hash FROM memories WHERE memory_id = ?
    `);
    const encoded = records.map((record, index) => {
      const raw = getRaw.get(record.memoryId) as unknown as
        | { scope_id: string; content_hash: string }
        | undefined;
      if (!raw) throw new Error(`Cannot index missing memory: ${record.memoryId}`);
      if (raw.scope_id !== record.scopeId) {
        throw new Error(`Embedding memory scope mismatch: ${record.memoryId}`);
      }
      if (raw.content_hash !== record.contentHash) {
        throw new Error(`Embedding content hash mismatch: ${record.memoryId}`);
      }
      return encodeFloat32Vector(vectors[index]!, profile.dimensions);
    });

    const getExisting = this.db.prepare(`
      SELECT model, dimensions, content_hash, vector
      FROM memory_embeddings
      WHERE memory_id = ? AND profile_id = ?
    `);
    const insert = this.db.prepare(`
      INSERT INTO memory_embeddings (
        memory_id, profile_id, model, dimensions, content_hash, vector
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    let unchanged = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      records.forEach((record, index) => {
        const existing = getExisting.get(
          record.memoryId,
          profile.profileId,
        ) as unknown as ExistingEmbeddingRow | undefined;
        const vector = encoded[index]!;
        if (existing) {
          if (
            existing.model !== profile.model ||
            existing.dimensions !== profile.dimensions ||
            existing.content_hash !== record.contentHash ||
            !equalBytes(existing.vector, vector)
          ) {
            throw new Error(
              `Derived embedding conflict for immutable memory: ${record.memoryId}`,
            );
          }
          unchanged += 1;
          return;
        }
        insert.run(
          record.memoryId,
          profile.profileId,
          profile.model,
          profile.dimensions,
          record.contentHash,
          vector,
        );
        inserted += 1;
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { inserted, unchanged };
  }

  beginVectorIndexGeneration(
    config: VectorIndexGenerationConfig,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.beginVectorIndexGeneration(config);
  }

  enqueueStoredScopeEmbeddingsForVectorGeneration(
    generationId: string,
    scopeId: string,
    profile: EmbeddingProfile,
  ): number {
    return this.vectorIndex.enqueueStoredScopeEmbeddingsForVectorGeneration(
      generationId,
      scopeId,
      profile,
    );
  }

  getVectorIndexGeneration(
    generationId: string,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.getVectorIndexGeneration(generationId);
  }

  sealVectorIndexGeneration(
    generationId: string,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.sealVectorIndexGeneration(generationId);
  }

  claimVectorSyncBatch(
    generationId: string,
    limit: number,
    leaseMs: number,
    nowMs = Date.now(),
  ): VectorSyncClaim[] {
    return this.vectorIndex.claimVectorSyncBatch(
      generationId,
      limit,
      leaseMs,
      nowMs,
    );
  }

  completeVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
  ): void {
    this.vectorIndex.completeVectorSyncBatch(generationId, sequenceIds);
  }

  releaseVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
    error: unknown,
  ): void {
    this.vectorIndex.releaseVectorSyncBatch(generationId, sequenceIds, error);
  }

  beginVectorIndexVerification(
    generationId: string,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.beginVectorIndexVerification(generationId);
  }

  markVectorIndexGenerationReady(
    generationId: string,
    observedVectorCount: number,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.markVectorIndexGenerationReady(
      generationId,
      observedVectorCount,
    );
  }

  failVectorIndexGeneration(generationId: string, error: unknown): void {
    this.vectorIndex.failVectorIndexGeneration(generationId, error);
  }

  assertVectorIndexGenerationReady(
    generationId: string,
  ): VectorIndexGenerationStatus {
    return this.vectorIndex.assertVectorIndexGenerationReady(generationId);
  }

  listVectorGenerationScopeCounts(
    generationId: string,
  ): Array<{ scopeId: string; count: number }> {
    return this.vectorIndex.listVectorGenerationScopeCounts(generationId);
  }

  getVectorGenerationScopeCount(
    generationId: string,
    scopeId: string,
  ): number {
    return this.vectorIndex.getVectorGenerationScopeCount(
      generationId,
      scopeId,
    );
  }

  listStoredEmbeddings(
    scopeId: string,
    profile: EmbeddingProfile,
    request: Omit<SearchRequest, "queries" | "limit"> = {},
  ): StoredEmbeddingRecord[] {
    if (request.roles?.length === 0 || request.sessionIds?.length === 0) return [];
    this.getEmbeddingIndexStatus(scopeId, profile);
    const where = [
      "m.scope_id = ?",
      "e.profile_id = ?",
      "e.model = ?",
      "e.dimensions = ?",
      "e.content_hash = m.content_hash",
    ];
    const params: Array<string | number> = [
      scopeId,
      profile.profileId,
      profile.model,
      profile.dimensions,
    ];
    if (request.sessionIds && request.sessionIds.length > 0) {
      where.push(
        `m.session_id IN (${request.sessionIds.map(() => "?").join(", ")})`,
      );
      params.push(...request.sessionIds);
    }
    if (request.roles && request.roles.length > 0) {
      where.push(`m.role IN (${request.roles.map(() => "?").join(", ")})`);
      params.push(...request.roles);
    }
    if (request.after) {
      where.push("julianday(m.timestamp) >= julianday(?)");
      params.push(request.after);
    }
    if (request.before) {
      where.push("julianday(m.timestamp) <= julianday(?)");
      params.push(request.before);
    }
    const rows = this.db.prepare(`
      SELECT m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
             m.content, m.timestamp, m.content_hash, m.metadata_json,
             e.vector
      FROM memories AS m
      CROSS JOIN memory_embeddings AS e ON e.memory_id = m.memory_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.memory_id ASC
    `).all(...params) as unknown as EmbeddingRow[];
    return rows.map((row) => ({
      record: memoryRowToRecord(row),
      vector: decodeFloat32Vector(row.vector, profile.dimensions),
    }));
  }

  findMentionedMemoryIds(scopeId: string, text: string): string[] {
    return this.listScopeRecords(scopeId)
      .map((record) => record.memoryId)
      .filter((memoryId) => text.includes(memoryId));
  }

  async exportScope(scopeId: string, exportRoot: string): Promise<ScopeExport> {
    return exportMemoryScope(scopeId, this.listScopeRecords(scopeId), exportRoot);
  }

  static async create(databasePath: string): Promise<MemoryStore> {
    await mkdir(dirname(databasePath), { recursive: true });
    return new MemoryStore(databasePath);
  }
}
