import { sha256 } from "../../util.js";
import {
  LdbdContractError,
  parseAddRequest,
  parseSearchRequest,
  type LdbdAddRequest,
  type LdbdSearchRequest,
} from "./contracts.js";

export interface LdbdSearchItem {
  id: string;
  content: string;
  created_at?: string;
}

export interface LdbdMemoryApplication {
  add(request: LdbdAddRequest): Promise<"inserted" | "unchanged">;
  search(request: LdbdSearchRequest, signal?: AbortSignal): Promise<LdbdSearchItem[]>;
}

export class LdbdConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LdbdConflictError";
  }
}

export class LdbdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LdbdUnavailableError";
  }
}

export function onlineScopeId(userId: string): string {
  return `leaderboard-${sha256(userId).slice(0, 24)}`;
}

export class LdbdApiService {
  constructor(private readonly application: LdbdMemoryApplication) {}

  async add(value: unknown): Promise<Record<string, unknown>> {
    const request = parseAddRequest(value);
    const status = await this.application.add(request);
    return {
      success: true,
      request_id: request.requestId,
      user_id: request.userId,
      session_id: request.sessionId,
      status,
    };
  }

  async search(value: unknown, signal?: AbortSignal): Promise<{ data: LdbdSearchItem[] }> {
    const request = parseSearchRequest(value);
    return { data: await this.application.search(request, signal) };
  }
}

export { LdbdContractError };
