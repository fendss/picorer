import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryRecord } from "../../memory/index.js";
import type {
  EmbeddingIndexStatus,
  EmbeddingProfile,
  VectorIndexGenerationConfig,
  VectorIndexGenerationState,
  VectorIndexGenerationStatus,
  VectorSyncClaim,
} from "../../retrieval/model/embedding.js";
import type { VectorIndexStateStore } from "../../retrieval/ports/vector-index-state-store.js";
import { decodeFloat32Vector } from "./float32-vector.js";

interface VectorGenerationRow {
  generation_id: string;
  collection_name: string;
  profile_id: string;
  model: string;
  dimensions: number;
  state: VectorIndexGenerationState;
  source_fingerprint: string | null;
  expected_vector_count: number;
  high_water_sequence: number;
  last_error: string | null;
}

interface VectorOutboxCountRow {
  synced: number;
  pending: number;
  inflight: number;
}

interface VectorSyncRow {
  sequence_id: number;
  generation_id: string;
  scope_id: string;
  memory_id: string;
  session_id: string;
  role: MemoryRecord["role"];
  timestamp: string | null;
  profile_id: string;
  content_hash: string;
  attempts: number;
  vector: Uint8Array;
  dimensions: number;
}

function requiredIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (value.length > 512) throw new Error(`${label} exceeds 512 characters`);
  return value;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function assertEmbeddingProfile(profile: EmbeddingProfile): void {
  if (!profile.profileId.trim()) throw new Error("Embedding profile ID must not be empty");
  if (!profile.model.trim()) throw new Error("Embedding model must not be empty");
  if (!Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1) {
    throw new Error("Embedding dimensions must be a positive integer");
  }
}

/** SQLite outbox and state machine for immutable external vector generations. */
export class SqliteVectorIndexStateStore implements VectorIndexStateStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly embeddingStatus: (
      scopeId: string,
      profile: EmbeddingProfile,
    ) => EmbeddingIndexStatus,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_index_generations (
        generation_id TEXT PRIMARY KEY,
        collection_name TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('ingesting', 'draining', 'verifying', 'ready', 'failed')
        ),
        source_fingerprint TEXT,
        expected_vector_count INTEGER NOT NULL DEFAULT 0,
        high_water_sequence INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vector_sync_outbox (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'synced')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until_ms INTEGER,
        last_error TEXT,
        UNIQUE (generation_id, memory_id, profile_id),
        FOREIGN KEY (generation_id)
          REFERENCES vector_index_generations(generation_id),
        FOREIGN KEY (memory_id, profile_id)
          REFERENCES memory_embeddings(memory_id, profile_id)
      );
      CREATE INDEX IF NOT EXISTS vector_sync_outbox_claim
        ON vector_sync_outbox(generation_id, state, sequence_id);
      CREATE INDEX IF NOT EXISTS vector_sync_outbox_scope
        ON vector_sync_outbox(generation_id, scope_id, state);
    `);
  }

  beginVectorIndexGeneration(
    config: VectorIndexGenerationConfig,
  ): VectorIndexGenerationStatus {
    requiredIdentity(config.generationId, "Vector generation ID");
    requiredIdentity(config.collectionName, "Vector collection name");
    assertEmbeddingProfile(config.profile);
    const existing = this.generationRow(config.generationId);
    if (existing !== undefined) {
      if (
        existing.collection_name !== config.collectionName ||
        existing.profile_id !== config.profile.profileId ||
        existing.model !== config.profile.model ||
        existing.dimensions !== config.profile.dimensions
      ) {
        throw new Error(
          `Vector generation configuration conflict: ${config.generationId}`,
        );
      }
      return this.getVectorIndexGeneration(config.generationId);
    }
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO vector_index_generations (
        generation_id, collection_name, profile_id, model, dimensions,
        state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'ingesting', ?, ?)
    `).run(
      config.generationId,
      config.collectionName,
      config.profile.profileId,
      config.profile.model,
      config.profile.dimensions,
      now,
      now,
    );
    return this.getVectorIndexGeneration(config.generationId);
  }

  enqueueStoredScopeEmbeddingsForVectorGeneration(
    generationId: string,
    scopeId: string,
    profile: EmbeddingProfile,
  ): number {
    requiredIdentity(generationId, "Vector generation ID");
    requiredIdentity(scopeId, "Vector scope ID");
    const embedding = this.embeddingStatus(scopeId, profile);
    if (embedding.missing !== 0) {
      throw new Error(
        `Cannot enqueue incomplete embedding scope ${scopeId}: ` +
          `${embedding.indexed}/${embedding.total}`,
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.generationRow(generationId);
      if (generation === undefined) {
        throw new Error(`Unknown vector generation: ${generationId}`);
      }
      if (generation.state !== "ingesting") {
        throw new Error(`Vector generation is sealed: ${generationId}`);
      }
      if (
        generation.profile_id !== profile.profileId ||
        generation.model !== profile.model ||
        generation.dimensions !== profile.dimensions
      ) {
        throw new Error(`Vector generation profile mismatch: ${generationId}`);
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO vector_sync_outbox (
          generation_id, scope_id, memory_id, profile_id, content_hash, state
        )
        SELECT ?, m.scope_id, m.memory_id, e.profile_id, e.content_hash, 'pending'
        FROM memories AS m
        JOIN memory_embeddings AS e ON e.memory_id = m.memory_id
        WHERE m.scope_id = ? AND e.profile_id = ?
          AND e.model = ? AND e.dimensions = ?
          AND e.content_hash = m.content_hash
        ORDER BY m.memory_id ASC
      `).run(
        generationId,
        scopeId,
        profile.profileId,
        profile.model,
        profile.dimensions,
      );
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getVectorIndexGeneration(
    generationId: string,
  ): VectorIndexGenerationStatus {
    requiredIdentity(generationId, "Vector generation ID");
    const row = this.generationRow(generationId);
    if (row === undefined) throw new Error(`Unknown vector generation: ${generationId}`);
    const counts = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state = 'synced' THEN 1 ELSE 0 END), 0) AS synced,
        COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN state = 'inflight' THEN 1 ELSE 0 END), 0) AS inflight
      FROM vector_sync_outbox
      WHERE generation_id = ?
    `).get(generationId) as unknown as VectorOutboxCountRow;
    return {
      generationId: row.generation_id,
      collectionName: row.collection_name,
      profile: {
        profileId: row.profile_id,
        model: row.model,
        dimensions: row.dimensions,
      },
      state: row.state,
      ...(row.source_fingerprint === null
        ? {}
        : { sourceFingerprint: row.source_fingerprint }),
      expectedVectorCount: row.expected_vector_count,
      syncedVectorCount: counts.synced,
      pendingVectorCount: counts.pending,
      inflightVectorCount: counts.inflight,
      highWaterSequence: row.high_water_sequence,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
    };
  }

  sealVectorIndexGeneration(
    generationId: string,
  ): VectorIndexGenerationStatus {
    requiredIdentity(generationId, "Vector generation ID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.generationRow(generationId);
      if (generation === undefined) {
        throw new Error(`Unknown vector generation: ${generationId}`);
      }
      if (generation.state === "failed") {
        throw new Error(`Cannot seal failed vector generation: ${generationId}`);
      }
      if (generation.state === "ingesting") {
        const aggregate = this.db.prepare(`
          SELECT COUNT(*) AS count, COALESCE(MAX(sequence_id), 0) AS high_water
          FROM vector_sync_outbox
          WHERE generation_id = ?
        `).get(generationId) as unknown as { count: number; high_water: number };
        this.db.prepare(`
          UPDATE vector_index_generations
          SET state = 'draining', expected_vector_count = ?,
              high_water_sequence = ?, updated_at_ms = ?
          WHERE generation_id = ? AND state = 'ingesting'
        `).run(aggregate.count, aggregate.high_water, Date.now(), generationId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const sealed = this.generationRow(generationId)!;
    if (sealed.source_fingerprint === null) {
      if (sealed.state !== "draining") {
        throw new Error(`Vector generation fingerprint is missing: ${generationId}`);
      }
      const fingerprint = this.generationFingerprint(generationId);
      this.db.prepare(`
        UPDATE vector_index_generations
        SET source_fingerprint = ?, updated_at_ms = ?
        WHERE generation_id = ? AND state = 'draining'
          AND source_fingerprint IS NULL
      `).run(fingerprint, Date.now(), generationId);
    }
    return this.getVectorIndexGeneration(generationId);
  }

  claimVectorSyncBatch(
    generationId: string,
    limit: number,
    leaseMs: number,
    nowMs = Date.now(),
  ): VectorSyncClaim[] {
    requiredIdentity(generationId, "Vector generation ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Vector sync batch limit must be between 1 and 10000");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Vector sync lease must be positive");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.generationRow(generationId);
      if (
        generation === undefined ||
        (generation.state !== "ingesting" && generation.state !== "draining")
      ) {
        throw new Error(`Vector generation does not accept sync claims: ${generationId}`);
      }
      this.db.prepare(`
        UPDATE vector_sync_outbox
        SET state = 'pending', lease_until_ms = NULL
        WHERE generation_id = ? AND state = 'inflight' AND lease_until_ms <= ?
      `).run(generationId, nowMs);
      const pending = this.db.prepare(`
        SELECT sequence_id FROM vector_sync_outbox
        WHERE generation_id = ? AND state = 'pending'
        ORDER BY sequence_id ASC LIMIT ?
      `).all(generationId, limit) as unknown as Array<{ sequence_id: number }>;
      const claim = this.db.prepare(`
        UPDATE vector_sync_outbox
        SET state = 'inflight', attempts = attempts + 1,
            lease_until_ms = ?, last_error = NULL
        WHERE generation_id = ? AND sequence_id = ? AND state = 'pending'
      `);
      for (const item of pending) {
        if (claim.run(nowMs + leaseMs, generationId, item.sequence_id).changes !== 1) {
          throw new Error(`Cannot claim vector sync row: ${item.sequence_id}`);
        }
      }
      const select = this.db.prepare(`
        SELECT o.sequence_id, o.generation_id, o.scope_id, o.memory_id,
               m.session_id, m.role, m.timestamp, o.profile_id,
               o.content_hash, o.attempts, e.vector, e.dimensions
        FROM vector_sync_outbox AS o
        JOIN memories AS m ON m.memory_id = o.memory_id
        JOIN memory_embeddings AS e
          ON e.memory_id = o.memory_id AND e.profile_id = o.profile_id
        WHERE o.generation_id = ? AND o.sequence_id = ? AND o.state = 'inflight'
      `);
      const rows = pending.map((item) =>
        select.get(generationId, item.sequence_id) as unknown as VectorSyncRow
      );
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        sequenceId: row.sequence_id,
        generationId: row.generation_id,
        scopeId: row.scope_id,
        memoryId: row.memory_id,
        sessionId: row.session_id,
        role: row.role,
        ...(row.timestamp === null ? {} : { timestamp: row.timestamp }),
        profileId: row.profile_id,
        contentHash: row.content_hash,
        vector: decodeFloat32Vector(row.vector, row.dimensions),
        attempts: row.attempts,
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
  ): void {
    this.updateVectorSyncBatch(generationId, sequenceIds, "synced");
  }

  releaseVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
    error: unknown,
  ): void {
    this.updateVectorSyncBatch(
      generationId,
      sequenceIds,
      "pending",
      boundedError(error),
    );
  }

  beginVectorIndexVerification(
    generationId: string,
  ): VectorIndexGenerationStatus {
    const before = this.getVectorIndexGeneration(generationId);
    if (before.state === "verifying") return before;
    if (
      before.state !== "draining" ||
      before.sourceFingerprint === undefined ||
      before.pendingVectorCount !== 0 ||
      before.inflightVectorCount !== 0 ||
      before.syncedVectorCount !== before.expectedVectorCount
    ) {
      throw new Error(`Vector generation is not fully synchronized: ${generationId}`);
    }
    const result = this.db.prepare(`
      UPDATE vector_index_generations SET state = 'verifying', updated_at_ms = ?
      WHERE generation_id = ? AND state = 'draining'
    `).run(Date.now(), generationId);
    if (result.changes !== 1) {
      throw new Error(`Cannot begin vector verification: ${generationId}`);
    }
    return this.getVectorIndexGeneration(generationId);
  }

  markVectorIndexGenerationReady(
    generationId: string,
    observedVectorCount: number,
  ): VectorIndexGenerationStatus {
    const before = this.getVectorIndexGeneration(generationId);
    if (before.state === "ready") return before;
    if (before.state !== "verifying") {
      throw new Error(`Vector generation is not being verified: ${generationId}`);
    }
    if (observedVectorCount !== before.expectedVectorCount) {
      throw new Error(
        `Vector generation count mismatch: ${observedVectorCount}/${before.expectedVectorCount}`,
      );
    }
    const result = this.db.prepare(`
      UPDATE vector_index_generations
      SET state = 'ready', last_error = NULL, updated_at_ms = ?
      WHERE generation_id = ? AND state = 'verifying'
    `).run(Date.now(), generationId);
    if (result.changes !== 1) throw new Error(`Cannot mark vector ready: ${generationId}`);
    return this.getVectorIndexGeneration(generationId);
  }

  failVectorIndexGeneration(generationId: string, error: unknown): void {
    const result = this.db.prepare(`
      UPDATE vector_index_generations
      SET state = 'failed', last_error = ?, updated_at_ms = ?
      WHERE generation_id = ? AND state <> 'ready'
    `).run(boundedError(error), Date.now(), generationId);
    if (result.changes !== 1) throw new Error(`Cannot fail vector generation: ${generationId}`);
  }

  assertVectorIndexGenerationReady(
    generationId: string,
  ): VectorIndexGenerationStatus {
    const status = this.getVectorIndexGeneration(generationId);
    if (status.state !== "ready") {
      throw new Error(`Vector generation is not ready: ${generationId}`);
    }
    return status;
  }

  listVectorGenerationScopeCounts(
    generationId: string,
  ): Array<{ scopeId: string; count: number }> {
    this.getVectorIndexGeneration(generationId);
    const rows = this.db.prepare(`
      SELECT scope_id, COUNT(*) AS count FROM vector_sync_outbox
      WHERE generation_id = ? GROUP BY scope_id ORDER BY scope_id ASC
    `).all(generationId) as unknown as Array<{ scope_id: string; count: number }>;
    return rows.map((row) => ({ scopeId: row.scope_id, count: row.count }));
  }

  getVectorGenerationScopeCount(
    generationId: string,
    scopeId: string,
  ): number {
    this.getVectorIndexGeneration(generationId);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM vector_sync_outbox
      WHERE generation_id = ? AND scope_id = ?
    `).get(generationId, scopeId) as unknown as { count: number };
    return row.count;
  }

  private generationRow(
    generationId: string,
  ): VectorGenerationRow | undefined {
    return this.db.prepare(`
      SELECT generation_id, collection_name, profile_id, model, dimensions,
             state, source_fingerprint, expected_vector_count,
             high_water_sequence, last_error
      FROM vector_index_generations
      WHERE generation_id = ?
    `).get(generationId) as unknown as VectorGenerationRow | undefined;
  }

  private generationFingerprint(generationId: string): string {
    const row = this.generationRow(generationId);
    if (row === undefined) throw new Error(`Unknown vector generation: ${generationId}`);
    const hash = createHash("sha256");
    hash.update(JSON.stringify([
      "picorer-qdrant-source-v1",
      row.profile_id,
      row.model,
      row.dimensions,
    ]));
    const records = this.db.prepare(`
      SELECT o.scope_id, o.memory_id, o.content_hash, e.vector
      FROM vector_sync_outbox AS o
      JOIN memory_embeddings AS e
        ON e.memory_id = o.memory_id AND e.profile_id = o.profile_id
      WHERE o.generation_id = ?
      ORDER BY o.scope_id ASC, o.memory_id ASC
    `).iterate(generationId) as unknown as Iterable<{
      scope_id: string;
      memory_id: string;
      content_hash: string;
      vector: Uint8Array;
    }>;
    for (const record of records) {
      hash.update("\0");
      hash.update(JSON.stringify([
        record.scope_id,
        record.memory_id,
        record.content_hash,
        record.vector.byteLength,
      ]));
      hash.update("\0");
      hash.update(record.vector);
    }
    return hash.digest("hex");
  }

  private updateVectorSyncBatch(
    generationId: string,
    sequenceIds: readonly number[],
    state: "pending" | "synced",
    lastError?: string,
  ): void {
    requiredIdentity(generationId, "Vector generation ID");
    if (sequenceIds.length === 0) return;
    if (
      new Set(sequenceIds).size !== sequenceIds.length ||
      sequenceIds.some((value) => !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new Error("Vector sync sequence IDs must be unique positive integers");
    }
    const statement = state === "synced"
      ? this.db.prepare(`
          UPDATE vector_sync_outbox
          SET state = 'synced', lease_until_ms = NULL, last_error = NULL
          WHERE generation_id = ? AND sequence_id = ?
            AND state IN ('inflight', 'synced')
        `)
      : this.db.prepare(`
          UPDATE vector_sync_outbox
          SET state = 'pending', lease_until_ms = NULL, last_error = ?
          WHERE generation_id = ? AND sequence_id = ? AND state = 'inflight'
        `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sequenceId of sequenceIds) {
        const result = state === "synced"
          ? statement.run(generationId, sequenceId)
          : statement.run(lastError ?? "Vector synchronization failed", generationId, sequenceId);
        if (result.changes !== 1) {
          throw new Error(`Cannot update vector sync row: ${sequenceId}`);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
