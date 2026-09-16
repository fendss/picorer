import type { MemorySessionInput } from "../memory/index.js";
import { ingestMemorySessions } from "../memory/index.js";
import { AsyncRequestGate } from "../platform/concurrency/request-gate.js";
import { runAsyncPool } from "../platform/concurrency/async-pool.js";
import { MemoryStore } from "../platform/sqlite/picorer-store.js";
import { OpenAICompatibleEmbedder } from "../retrieval/adapters/openai/openai-compatible-embedder.js";
import {
  embeddingProfile,
  indexScopeEmbeddings,
  type EmbeddingIndexResult,
} from "../retrieval/index-scope-embeddings.js";
import type { RetrievalMetadata, RetrievalProfile } from "../retrieval/index.js";
import {
  publishQdrantGeneration,
  qdrantRetrievalConfiguration,
  qdrantVectorSearchConfiguration,
} from "./qdrant-retrieval.js";

export interface IngestMemoryWorkspaceOptions {
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

export interface IngestMemoryWorkspaceResult {
  scopes: Awaited<ReturnType<typeof ingestMemorySessions>>;
  retrieval: RetrievalMetadata;
  embeddingIndexes: EmbeddingIndexResult[];
}

/** Wires immutable session ingest to SQLite and optional embeddings. */
export async function ingestMemoryWorkspace(
  options: IngestMemoryWorkspaceOptions,
): Promise<IngestMemoryWorkspaceResult> {
  const embeddingSlots = options.embeddingSlots ?? 1;
  const embeddingRequestsPerSecond = options.embeddingRequestsPerSecond ?? 6;
  const store = await MemoryStore.create(options.paths.database);
  try {
    const scopes = options.sessions.length === 0
      ? []
      : await ingestMemorySessions(store, options.sessions, {
          exportRoot: options.paths.sanitized,
        });
    if (options.retrievalProfile === "fts5") {
      return {
        scopes,
        retrieval: { retrievalProfile: "fts5" },
        embeddingIndexes: [],
      };
    }

    const requestGate = new AsyncRequestGate(
      embeddingSlots,
      embeddingRequestsPerSecond,
    );
    const embedders = Array.from({ length: embeddingSlots }, () =>
      OpenAICompatibleEmbedder.fromEnvironment(
        options.environment ?? process.env,
        undefined,
        requestGate,
      ),
    );
    const profile = embeddingProfile(embedders[0]!);
    let firstError: unknown;
    let halted = false;
    let settled = 0;
    const indexed = await runAsyncPool(
      scopes,
      embeddingSlots,
      async (scope, context): Promise<EmbeddingIndexResult | undefined> => {
        if (halted) return undefined;
        try {
          return await indexScopeEmbeddings(
            store,
            scope.scopeId,
            embedders[context.slot - 1]!,
          );
        } catch (error) {
          firstError ??= error;
          halted = true;
          return undefined;
        } finally {
          settled += 1;
          options.onScopeSettled?.({
            slot: context.slot,
            settled,
            total: scopes.length,
            scopeId: scope.scopeId,
          });
        }
      },
    );
    if (firstError !== undefined) throw firstError;
    const qdrantConfig = options.retrievalProfile ===
        "picorer-hybrid-qdrant-hnsw-v1"
      ? qdrantRetrievalConfiguration(
          embedders[0]!,
          options.environment ?? process.env,
        )
      : undefined;
    const qdrant = qdrantConfig === undefined
      ? undefined
      : await publishQdrantGeneration(
          store,
          embedders[0]!,
          scopes.map((scope) => scope.scopeId),
          options.environment ?? process.env,
        );
    const vectorSearch = qdrantConfig === undefined
      ? undefined
      : {
          ...qdrantVectorSearchConfiguration(qdrantConfig),
          fallbackPolicy: "sqlite-exact-on-unavailable-v1" as const,
        };
    const retrieval: RetrievalMetadata = {
      retrievalProfile: options.retrievalProfile,
      embeddingProfileId: profile.profileId,
      embeddingModel: profile.model,
      embeddingDimensions: profile.dimensions,
      ...(qdrant === undefined || vectorSearch === undefined
        ? {}
        : {
            vectorGenerationId: qdrant.generationId,
            vectorCollection: qdrant.collectionName,
            vectorSearch,
          }),
    };
    return {
      scopes,
      retrieval,
      embeddingIndexes: indexed.filter(
        (item): item is EmbeddingIndexResult => item !== undefined,
      ),
    };
  } finally {
    store.close();
  }
}
