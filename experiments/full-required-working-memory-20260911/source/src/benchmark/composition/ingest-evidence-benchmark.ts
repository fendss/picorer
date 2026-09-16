import type { MemorySessionInput } from "../../memory/index.js";
import type { RetrievalProfile } from "../../retrieval/index.js";
import {
  ingestMemoryWorkspace,
  type IngestMemoryWorkspaceResult,
} from "../../composition/ingest-memory-workspace.js";
import { assertBenchmarkLabelFirewall } from "../label-firewall.js";

export interface IngestEvidenceBenchmarkOptions {
  paths: { database: string; sanitized: string };
  sessions: readonly MemorySessionInput[];
  retrievalProfile: RetrievalProfile;
  embeddingSlots?: number;
  embeddingRequestsPerSecond?: number;
  environment?: NodeJS.ProcessEnv;
  onScopeSettled?: (progress: {
    slot: number;
    settled: number;
    total: number;
    scopeId: string;
  }) => void;
}

/** Applies the private-label firewall before delegating to generic ingest. */
export async function ingestEvidenceBenchmark(
  options: IngestEvidenceBenchmarkOptions,
): Promise<IngestMemoryWorkspaceResult> {
  assertBenchmarkLabelFirewall(options.sessions);
  return ingestMemoryWorkspace(options);
}
