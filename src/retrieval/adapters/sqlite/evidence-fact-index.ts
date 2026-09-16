import type { DatabaseSync } from "node:sqlite";
import { extractNumericFacts } from "../../operators/numeric-operator.js";
import { extractTemporalFacts } from "../../operators/temporal-operator.js";
import { sourceCalendarTimestamp } from "../../model/source-time.js";
import type { MemoryRecord } from "../../../memory/index.js";
import {
  type MemoryRow,
  memoryRowToRecord,
} from "../../../platform/sqlite/memory-row.js";

export const EVIDENCE_FACT_EXTRACTOR_VERSION = "picorer-evidence-facts-v2";

export interface EvidenceFactIndexStatus {
  indexedMemories: number;
  numericFacts: number;
  temporalFacts: number;
}

/**
 * Versioned, deterministic sidecar index for immutable raw memories.
 * Deleting these tables never deletes or changes a source memory.
 */
export class EvidenceFactIndex {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initializeSchema();
  }

  ensureScope(scopeId: string): EvidenceFactIndexStatus {
    this.assertContentHashes(scopeId);
    const missing = this.listUnindexedRows(scopeId);
    if (missing.length > 0) this.indexRows(missing);
    return this.status(scopeId);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_evidence_fact_index (
        memory_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (memory_id, extractor_version),
        FOREIGN KEY (memory_id) REFERENCES memories(memory_id)
      );
      CREATE TABLE IF NOT EXISTS memory_numeric_facts (
        scope_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        fact_index INTEGER NOT NULL,
        span_start INTEGER NOT NULL,
        span_end INTEGER NOT NULL,
        raw_value TEXT NOT NULL,
        numeric_value REAL NOT NULL,
        unit TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        PRIMARY KEY (memory_id, extractor_version, fact_index),
        FOREIGN KEY (memory_id) REFERENCES memories(memory_id)
      );
      CREATE INDEX IF NOT EXISTS memory_numeric_facts_scope
        ON memory_numeric_facts(scope_id, extractor_version, memory_id);
      CREATE TABLE IF NOT EXISTS memory_temporal_facts (
        scope_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        fact_index INTEGER NOT NULL,
        span_start INTEGER NOT NULL,
        span_end INTEGER NOT NULL,
        expression TEXT NOT NULL,
        resolved_date TEXT NOT NULL,
        basis TEXT NOT NULL,
        PRIMARY KEY (memory_id, extractor_version, fact_index),
        FOREIGN KEY (memory_id) REFERENCES memories(memory_id)
      );
      CREATE INDEX IF NOT EXISTS memory_temporal_facts_scope_date
        ON memory_temporal_facts(
          scope_id, extractor_version, resolved_date, memory_id
        );
    `);
  }

  private assertContentHashes(scopeId: string): void {
    const conflict = this.db.prepare(`
      SELECT 1
      FROM memory_evidence_fact_index AS i
      JOIN memories AS m ON m.memory_id = i.memory_id
      WHERE m.scope_id = ? AND i.extractor_version = ?
        AND i.content_hash <> m.content_hash
      LIMIT 1
    `).get(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION);
    if (conflict) {
      throw new Error(`Evidence fact content hash conflict in scope ${scopeId}`);
    }
  }

  private listUnindexedRows(scopeId: string): MemoryRow[] {
    return this.db.prepare(`
      SELECT m.memory_id, m.scope_id, m.session_id, m.turn_index, m.role,
             m.content, m.timestamp, m.content_hash, m.metadata_json
      FROM memories AS m
      WHERE m.scope_id = ? AND NOT EXISTS (
        SELECT 1 FROM memory_evidence_fact_index AS i
        WHERE i.memory_id = m.memory_id AND i.extractor_version = ?
      )
      ORDER BY m.timestamp IS NULL ASC, m.timestamp ASC,
               m.session_id ASC, m.turn_index ASC
    `).all(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as MemoryRow[];
  }

  private indexRows(rows: readonly MemoryRow[]): void {
    const insertNumeric = this.db.prepare(`
      INSERT INTO memory_numeric_facts (
        scope_id, memory_id, extractor_version, fact_index,
        span_start, span_end, raw_value, numeric_value, unit, value_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTemporal = this.db.prepare(`
      INSERT INTO memory_temporal_facts (
        scope_id, memory_id, extractor_version, fact_index,
        span_start, span_end, expression, resolved_date, basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const markIndexed = this.db.prepare(`
      INSERT INTO memory_evidence_fact_index (
        memory_id, extractor_version, content_hash
      ) VALUES (?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) this.indexRecord(row, insertNumeric, insertTemporal, markIndexed);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private indexRecord(
    row: MemoryRow,
    insertNumeric: ReturnType<DatabaseSync["prepare"]>,
    insertTemporal: ReturnType<DatabaseSync["prepare"]>,
    markIndexed: ReturnType<DatabaseSync["prepare"]>,
  ): void {
    const record = memoryRowToRecord(row);
    extractNumericFacts(record.content).forEach((fact, factIndex) => {
      insertNumeric.run(
        record.scopeId,
        record.memoryId,
        EVIDENCE_FACT_EXTRACTOR_VERSION,
        factIndex,
        fact.index,
        fact.end,
        fact.raw,
        fact.value,
        fact.unit,
        fact.valueKind,
      );
    });

    let temporalFactIndex = 0;
    const sourceTime = sourceCalendarTimestamp(record.timestamp);
    if (sourceTime !== undefined) {
      const sourceDate = new Date(sourceTime).toISOString().slice(0, 10);
      insertTemporal.run(
        record.scopeId,
        record.memoryId,
        EVIDENCE_FACT_EXTRACTOR_VERSION,
        temporalFactIndex,
        -1,
        -1,
        "source timestamp",
        sourceDate,
        "source-timestamp",
      );
      temporalFactIndex += 1;
    }
    for (const fact of extractTemporalFacts(record.content, record.timestamp)) {
      insertTemporal.run(
        record.scopeId,
        record.memoryId,
        EVIDENCE_FACT_EXTRACTOR_VERSION,
        temporalFactIndex,
        fact.index,
        fact.end,
        fact.expression,
        fact.resolvedDate,
        fact.basis,
      );
      temporalFactIndex += 1;
    }
    markIndexed.run(
      record.memoryId,
      EVIDENCE_FACT_EXTRACTOR_VERSION,
      record.contentHash,
    );
  }

  private status(scopeId: string): EvidenceFactIndexStatus {
    const indexed = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_evidence_fact_index AS i
      JOIN memories AS m ON m.memory_id = i.memory_id
      WHERE m.scope_id = ? AND i.extractor_version = ?
    `).get(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as { count: number };
    const numeric = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_numeric_facts
      WHERE scope_id = ? AND extractor_version = ?
    `).get(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as { count: number };
    const temporal = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_temporal_facts
      WHERE scope_id = ? AND extractor_version = ?
    `).get(scopeId, EVIDENCE_FACT_EXTRACTOR_VERSION) as unknown as { count: number };
    return {
      indexedMemories: indexed.count,
      numericFacts: numeric.count,
      temporalFacts: temporal.count,
    };
  }
}
