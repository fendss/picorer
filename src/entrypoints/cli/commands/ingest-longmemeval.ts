import { resolve } from "node:path";
import { assertBenchmarkLabelFirewall } from "../../../benchmark/index.js";
import { loadLongMemEvalS } from "../../../benchmark/longmemeval/dataset-adapter.js";
import { dataPaths } from "../../../benchmark/longmemeval/data-paths.js";
import { mergeScopeRecords } from "../private-records.js";
import { ingestMemorySessions } from "../../../memory/ingest-memory-sessions.js";
import { runAsyncPool } from "../../../platform/concurrency/async-pool.js";
import { AsyncRequestGate } from "../../../platform/concurrency/request-gate.js";
import { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import { OpenAICompatibleEmbedder } from "../../../retrieval/adapters/openai/openai-compatible-embedder.js";
import {
  embeddingProfile,
  indexScopeEmbeddings,
  type EmbeddingIndexResult,
} from "../../../retrieval/index-scope-embeddings.js";
import type { RetrievalMetadata } from "../../../retrieval/index.js";
import {
  publishQdrantGeneration,
  qdrantRetrievalConfiguration,
  qdrantVectorSearchConfiguration,
} from "../../../composition/qdrant-retrieval.js";
import {
  assertOnlyFlags,
  positiveIntegerFlag,
  positiveNumberFlag,
  requiredFlag,
  retrievalProfileFor,
  type ParsedCommand,
} from "../parse-command.js";

export async function ingestLongMemEval(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "source",
    "data-dir",
    "question-id",
    "retrieval-profile",
    "embedding-slots",
    "embedding-rps",
  ]);
  const source = resolve(requiredFlag(parsed, "source"));
  const paths = dataPaths(requiredFlag(parsed, "data-dir"));
  const retrievalProfile = retrievalProfileFor(parsed);
  const embeddingSlots = positiveIntegerFlag(parsed, "embedding-slots", 1, 128);
  const embeddingRequestsPerSecond = positiveNumberFlag(
    parsed,
    "embedding-rps",
    6,
    100,
  );
  if (
    retrievalProfile === "fts5" &&
    (parsed.flags.has("embedding-slots") || parsed.flags.has("embedding-rps"))
  ) {
    throw new Error("Embedding concurrency flags require a hybrid retrieval profile");
  }
  const requestedIds = new Set(parsed.flags.get("question-id") ?? []);
  const adapted = await loadLongMemEvalS(source);

  const selectedQuestions =
    requestedIds.size === 0
      ? adapted.privateQuestions
      : adapted.privateQuestions.filter((question) =>
          requestedIds.has(question.questionId),
        );
  if (
    requestedIds.size > 0 &&
    selectedQuestions.length !== requestedIds.size
  ) {
    const found = new Set(
      selectedQuestions.map((question) => question.questionId),
    );
    const missing = [...requestedIds].filter((id) => !found.has(id));
    throw new Error(`Unknown LongMemEval question ID: ${missing.join(", ")}`);
  }

  const selectedScopes = new Set(
    selectedQuestions.map((question) => question.scopeId),
  );
  const sessions = adapted.memorySessions.filter((session) =>
    selectedScopes.has(session.scopeId),
  );
  assertBenchmarkLabelFirewall(sessions);
  const store = await MemoryStore.create(paths.database);
  try {
    const results = await ingestMemorySessions(store, sessions, {
      exportRoot: paths.sanitized,
    });
    let retrieval: RetrievalMetadata = { retrievalProfile: "fts5" };
    let embeddingIndexes: EmbeddingIndexResult[] = [];
    if (retrievalProfile !== "fts5") {
      const requestGate = new AsyncRequestGate(
        embeddingSlots,
        embeddingRequestsPerSecond,
      );
      const embedders = Array.from({ length: embeddingSlots }, () =>
        OpenAICompatibleEmbedder.fromEnvironment(
          process.env,
          undefined,
          requestGate,
        ),
      );
      const profile = embeddingProfile(embedders[0]!);
      let firstError: unknown;
      let halted = false;
      let settledScopes = 0;
      const indexes = await runAsyncPool(
        results,
        embeddingSlots,
        async (result, context): Promise<EmbeddingIndexResult | undefined> => {
          if (halted) return undefined;
          try {
            return await indexScopeEmbeddings(
              store,
              result.scopeId,
              embedders[context.slot - 1]!,
            );
          } catch (error) {
            firstError ??= error;
            halted = true;
            return undefined;
          } finally {
            settledScopes += 1;
            process.stderr.write(
              `[embedding slot ${context.slot}] ` +
                `[${settledScopes}/${results.length}] ${result.scopeId}\n`,
            );
          }
        },
      );
      if (firstError !== undefined) throw firstError;
      embeddingIndexes = indexes.filter(
        (index): index is EmbeddingIndexResult => index !== undefined,
      );
      const qdrantConfig = retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1"
        ? qdrantRetrievalConfiguration(embedders[0]!)
        : undefined;
      const qdrant = qdrantConfig === undefined
        ? undefined
        : await publishQdrantGeneration(
            store,
            embedders[0]!,
            results.map((result) => result.scopeId),
          );
      const vectorSearch = qdrantConfig === undefined
        ? undefined
        : {
            ...qdrantVectorSearchConfiguration(qdrantConfig),
            fallbackPolicy: "sqlite-exact-on-unavailable-v1" as const,
          };
      retrieval = {
        retrievalProfile,
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
    }
    await mergeScopeRecords(paths.privateQuestions, selectedQuestions);
    process.stdout.write(
      `${JSON.stringify({
        command: "ingest-longmemeval",
        retrieval,
        ...(retrievalProfile !== "fts5"
          ? {
              embeddingConcurrency: {
                slots: embeddingSlots,
                requestsPerSecond: embeddingRequestsPerSecond,
              },
            }
          : {}),
        scopes: results,
        embeddingIndexes,
        privateQuestionCount: selectedQuestions.length,
      }, null, 2)}\n`,
    );
  } finally {
    store.close();
  }
}
