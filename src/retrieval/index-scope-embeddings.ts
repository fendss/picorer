import type { Embedder } from "./model/embedder.js";
import type {
  EmbeddingIndexStatus,
  EmbeddingIndexStore,
  EmbeddingProfile,
} from "./model/embedding.js";

export const EMBEDDING_INPUT_FORMAT = "role: exact-original-content";

export interface EmbeddingIndexResult extends EmbeddingIndexStatus {
  indexedNow: number;
  skipped: number;
}

export function embeddingProfile(embedder: Embedder): EmbeddingProfile {
  return {
    profileId: embedder.profileId,
    model: embedder.model,
    dimensions: embedder.dimensions,
  };
}

export function embeddingInput(role: string, content: string): string {
  return `${role}: ${content}`;
}

export async function indexScopeEmbeddings(
  store: EmbeddingIndexStore,
  scopeId: string,
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<EmbeddingIndexResult> {
  const profile = embeddingProfile(embedder);
  const before = store.getEmbeddingIndexStatus(scopeId, profile);
  if (before.total === 0) {
    throw new Error(`Cannot index embeddings for empty scope: ${scopeId}`);
  }
  const missingRecords = store.listMissingEmbeddingRecords(scopeId, profile);
  let indexedNow = 0;
  let unchangedNow = 0;
  for (let offset = 0; offset < missingRecords.length; offset += embedder.batchSize) {
    const batch = missingRecords.slice(offset, offset + embedder.batchSize);
    const inputs = batch.map((record) =>
      embeddingInput(record.role, record.content),
    );
    const vectors =
      signal === undefined
        ? await embedder.embedDocuments(inputs)
        : await embedder.embedDocuments(inputs, { signal });
    const stored = store.storeEmbeddingBatch(batch, profile, vectors);
    indexedNow += stored.inserted;
    unchangedNow += stored.unchanged;
  }
  const after = store.getEmbeddingIndexStatus(scopeId, profile);
  return {
    ...after,
    indexedNow,
    skipped: before.indexed + unchangedNow,
  };
}
