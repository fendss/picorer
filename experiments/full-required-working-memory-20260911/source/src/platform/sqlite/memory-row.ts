import type { MemoryRecord } from "../../memory/index.js";

export interface MemoryRow {
  memory_id: string;
  scope_id: string;
  session_id: string;
  turn_index: number;
  role: MemoryRecord["role"];
  content: string;
  timestamp: string | null;
  content_hash: string;
  metadata_json: string;
}

export function memoryRowToRecord(row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    memoryId: row.memory_id,
    scopeId: row.scope_id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    role: row.role,
    content: row.content,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
  return row.timestamp === null ? record : { ...record, timestamp: row.timestamp };
}
