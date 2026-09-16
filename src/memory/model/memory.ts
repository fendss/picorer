export type MemoryRole = "user" | "assistant" | "system" | "other";

export interface MemoryTurnInput {
  id?: string;
  role: MemoryRole;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySessionInput {
  scopeId: string;
  sessionId: string;
  timestamp?: string;
  turns: MemoryTurnInput[];
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  memoryId: string;
  scopeId: string;
  sessionId: string;
  turnIndex: number;
  role: MemoryRole;
  content: string;
  timestamp?: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export type ScopeIngestStatus = "inserted" | "unchanged";

export interface AppendMemoryMessage {
  role: MemoryRole;
  content: string;
  timestamp?: string;
}

export interface AppendMemoryRequest {
  requestId: string;
  requestHash: string;
  scopeId: string;
  sourceSessionId: string;
  messages: readonly AppendMemoryMessage[];
}

export interface AppendMemoryResult {
  status: "pending" | "complete";
  records: MemoryRecord[];
}

export type OnlineScopeState = "ingesting" | "sealed";
