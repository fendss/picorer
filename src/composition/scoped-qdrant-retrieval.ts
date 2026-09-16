import type { MemoryRecord } from "../memory/index.js";
import type { MemoryStore } from "../platform/sqlite/picorer-store.js";
import type { Embedder } from "../retrieval/index.js";
import { sha256 } from "../util.js";
import {
  createRetrievalContext,
  type RetrievalContext,
} from "./create-retrieval-context.js";
import {
  publishQdrantGeneration,
  qdrantRetrievalConfiguration,
} from "./qdrant-retrieval.js";

function corpusFingerprint(records: readonly MemoryRecord[]): string {
  return sha256(JSON.stringify(records
    .map((record) => [record.memoryId, record.contentHash])
    .sort(([left], [right]) => left!.localeCompare(right!))));
}

export function scopedQdrantGenerationId(
  baseGenerationId: string,
  scopeId: string,
  records: readonly MemoryRecord[],
): string {
  const base = baseGenerationId.trim();
  if (!base) throw new Error("PICORER_VECTOR_GENERATION_ID must not be empty");
  if (!scopeId.trim()) throw new Error("Qdrant scope ID must not be empty");
  if (records.length === 0 || records.some((record) => record.scopeId !== scopeId)) {
    throw new Error(`Cannot derive Qdrant generation for empty or mixed scope ${scopeId}`);
  }
  return [
    base.slice(0, 440),
    `s${sha256(scopeId).slice(0, 16)}`,
    `c${corpusFingerprint(records).slice(0, 24)}`,
  ].join("-");
}

/** Publishes and reuses the immutable Qdrant generation for a scope version. */
export class ScopedQdrantRetrieval {
  private readonly publications = new Map<string, Promise<void>>();
  private readonly baseGenerationId: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.baseGenerationId = qdrantRetrievalConfiguration(
      this.embedder,
      this.environment,
    ).generationId;
  }

  private generationEnvironment(scopeId: string): {
    environment: NodeJS.ProcessEnv;
    generationId: string;
  } {
    const records = this.store.listScopeRecords(scopeId);
    const generationId = scopedQdrantGenerationId(
      this.baseGenerationId,
      scopeId,
      records,
    );
    return {
      generationId,
      environment: {
        ...this.environment,
        PICORER_VECTOR_GENERATION_ID: generationId,
      },
    };
  }

  async context(scopeId: string): Promise<RetrievalContext> {
    const selected = this.generationEnvironment(scopeId);
    let publication = this.publications.get(selected.generationId);
    if (publication === undefined) {
      publication = publishQdrantGeneration(
        this.store,
        this.embedder,
        [scopeId],
        selected.environment,
      ).then(() => undefined);
      this.publications.set(selected.generationId, publication);
    }
    try {
      await publication;
    } catch (error) {
      if (this.publications.get(selected.generationId) === publication) {
        this.publications.delete(selected.generationId);
      }
      throw error;
    }
    if (this.generationEnvironment(scopeId).generationId !== selected.generationId) {
      throw new Error(`Memory scope changed while publishing Qdrant generation: ${scopeId}`);
    }
    return createRetrievalContext(
      this.store,
      "picorer-hybrid-qdrant-hnsw-v1",
      this.embedder,
      selected.environment,
    );
  }
}
