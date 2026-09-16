import type { RetrievalProfile } from "./model/search.js";

export const DEFAULT_RETRIEVAL_PROFILE: RetrievalProfile = "fts5";

export function parseRetrievalProfile(
  value: string | undefined,
): RetrievalProfile {
  const normalized = value?.trim() || DEFAULT_RETRIEVAL_PROFILE;
  if (
    normalized === "fts5" ||
    normalized === "picorer-hybrid" ||
    normalized === "picorer-hybrid-qdrant-hnsw-v1"
  ) {
    return normalized;
  }
  throw new Error(
    `Unknown retrieval profile: ${normalized}; expected fts5, picorer-hybrid, ` +
      `or picorer-hybrid-qdrant-hnsw-v1`,
  );
}
