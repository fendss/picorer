import type {
  AppendMemoryRequest,
  AppendMemoryResult,
  MemoryRecord,
  OnlineScopeState,
  ScopeIngestStatus,
} from "../model/memory.js";

export interface ScopeExport {
  scopeId: string;
  path: string;
  memoryCount: number;
}

export interface MemoryIngestStore {
  ingestScope(
    scopeId: string,
    records: MemoryRecord[],
  ): ScopeIngestStatus;
  exportScope(scopeId: string, exportRoot: string): Promise<ScopeExport>;
}

export interface OnlineMemoryStore {
  appendMemoryRequest(request: AppendMemoryRequest): AppendMemoryResult;
  markAppendRequestComplete(requestId: string, requestHash: string): void;
  hasPendingAppendRequests(scopeId: string): boolean;
  getOnlineScopeState(scopeId: string): OnlineScopeState | undefined;
  sealOnlineScope(scopeId: string): OnlineScopeState;
}
