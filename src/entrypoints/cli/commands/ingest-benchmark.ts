import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AMA_BENCH_V4_IDENTITY,
  loadPinnedAmaBenchV4File,
  type AmaBenchPrivateLabel,
  type AmaBenchPrivateQuery,
} from "../../../benchmark/amabench/index.js";
import {
  evidenceBenchmarkDataPaths,
  type EvidenceBenchmarkDataPaths,
  type EvidenceBenchmarkId,
} from "../../../benchmark/index.js";
import { ingestEvidenceBenchmark } from "../../../benchmark/composition/ingest-evidence-benchmark.js";
import type { MemorySessionInput } from "../../../memory/index.js";
import {
  assertOnlyFlags,
  positiveIntegerFlag,
  positiveNumberFlag,
  requiredFlag,
  retrievalProfileFor,
  type ParsedCommand,
} from "../parse-command.js";
import { readJsonFileIfPresent, writeAtomicJson } from "../workflow-files.js";
import { mergeQuestionRecords, readQuestionRecords } from "../private-records.js";

interface DatasetIdentity {
  benchmark: EvidenceBenchmarkId;
  split: string;
  track: string;
  source: Record<string, unknown>;
}

interface StoredDatasetManifest {
  schema_version: number;
  identity: DatasetIdentity;
  retrieval?: { retrievalProfile?: unknown };
}

interface AdaptedSelection {
  identity: DatasetIdentity;
  sessions: MemorySessionInput[];
  queries: AmaBenchPrivateQuery[];
  labels: AmaBenchPrivateLabel[];
}

function benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId {
  const benchmark = requiredFlag(parsed, "benchmark");
  if (benchmark !== "ama-bench") {
    throw new Error(`Unknown benchmark: ${benchmark}`);
  }
  return benchmark;
}

function selectCases<T extends { questionId: string }>(
  values: readonly T[],
  requestedIds: ReadonlySet<string>,
): T[] {
  const selected = requestedIds.size === 0
    ? [...values]
    : values.filter((value) => requestedIds.has(value.questionId));
  if (requestedIds.size > 0 && selected.length !== requestedIds.size) {
    const found = new Set(selected.map((value) => value.questionId));
    const missing = [...requestedIds].filter((id) => !found.has(id));
    throw new Error(`Unknown benchmark case ID: ${missing.join(", ")}`);
  }
  if (selected.length === 0) throw new Error("No benchmark cases selected");
  return selected;
}

async function loadAmaSelection(
  parsed: ParsedCommand,
  requestedIds: ReadonlySet<string>,
): Promise<AdaptedSelection> {
  const source = resolve(requiredFlag(parsed, "source"));
  const adapted = await loadPinnedAmaBenchV4File(source);
  const queries = selectCases(adapted.privateQueries, requestedIds);
  const selectedIds = new Set(queries.map((query) => query.questionId));
  const selectedScopes = new Set(queries.map((query) => query.scopeId));
  return {
    identity: {
      benchmark: "ama-bench",
      split: "real-world-open-ended-v4",
      track: "official-open-ended",
      source: AMA_BENCH_V4_IDENTITY,
    },
    sessions: adapted.memorySessions.filter((session) =>
      selectedScopes.has(session.scopeId)
    ),
    queries,
    labels: adapted.privateLabels.filter((label) =>
      selectedIds.has(label.questionId)
    ),
  };
}

async function writeDatasetManifest(options: {
  path: string;
  identity: DatasetIdentity;
  dataPaths: EvidenceBenchmarkDataPaths;
  retrieval: unknown;
}): Promise<number> {
  const queries = await readQuestionRecords(
    options.dataPaths.privateQueries,
  );
  await writeAtomicJson(options.path, {
    schema_version: 1,
    identity: options.identity,
    retrieval: options.retrieval,
    case_count: queries.length,
  });
  return queries.length;
}

async function assertDatasetIdentity(
  path: string,
  identity: DatasetIdentity,
): Promise<StoredDatasetManifest | undefined> {
  const existing = await readJsonFileIfPresent<StoredDatasetManifest>(path);
  if (
    existing !== undefined &&
    (existing.schema_version !== 1 ||
      JSON.stringify(existing.identity) !== JSON.stringify(identity))
  ) {
    throw new Error("Data directory belongs to a different benchmark dataset");
  }
  return existing;
}

async function withDataDirectoryLock<T>(
  databasePath: string,
  action: () => Promise<T>,
): Promise<T> {
  const root = dirname(databasePath);
  const lockPath = join(root, ".ingest.lock");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Another ingest is already writing this data directory");
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await rmdir(lockPath);
  }
}

export async function ingestBenchmark(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "benchmark",
    "source",
    "data-dir",
    "case-id",
    "retrieval-profile",
    "embedding-slots",
    "embedding-rps",
  ]);
  const benchmark = benchmarkFor(parsed);
  const retrievalProfile = retrievalProfileFor(parsed);
  const embeddingSlots = positiveIntegerFlag(
    parsed,
    "embedding-slots",
    1,
    128,
  );
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

  const requestedIds = new Set(parsed.flags.get("case-id") ?? []);
  const selection = await loadAmaSelection(parsed, requestedIds);
  const dataPaths = evidenceBenchmarkDataPaths(requiredFlag(parsed, "data-dir"));
  const summary = await withDataDirectoryLock(
    dataPaths.database,
    async (): Promise<Record<string, unknown>> => {
      const existing = await assertDatasetIdentity(
        dataPaths.datasetManifest,
        selection.identity,
      );
      const existingProfile = existing?.retrieval?.retrievalProfile;
      if (
        existingProfile !== undefined && existingProfile !== retrievalProfile
      ) {
        throw new Error(
          `Data directory retrieval profile is ${String(existingProfile)}; ` +
            `cannot ingest ${retrievalProfile}`,
        );
      }
      const result = await ingestEvidenceBenchmark({
        paths: dataPaths,
        sessions: selection.sessions,
        retrievalProfile,
        embeddingSlots,
        embeddingRequestsPerSecond,
        onScopeSettled: (progress) => {
          process.stderr.write(
            `[embedding slot ${progress.slot}] ` +
              `[${progress.settled}/${progress.total}] ${progress.scopeId}\n`,
          );
        },
      });
      if (
        existing?.retrieval !== undefined &&
        JSON.stringify(existing.retrieval) !== JSON.stringify(result.retrieval)
      ) {
        throw new Error(
          "Data directory embedding identity differs from this ingest",
        );
      }
      await Promise.all([
        mergeQuestionRecords(
          dataPaths.privateQueries,
          selection.queries,
        ),
        mergeQuestionRecords(
          dataPaths.privateLabels,
          selection.labels,
        ),
      ]);
      const caseCount = await writeDatasetManifest({
        path: dataPaths.datasetManifest,
        identity: selection.identity,
        dataPaths,
        retrieval: result.retrieval,
      });
      return {
        command: "ingest-benchmark",
        benchmark,
        track: selection.identity.track,
        retrieval: result.retrieval,
        selected_case_count: selection.queries.length,
        stored_case_count: caseCount,
        ingested_scope_count: new Set(
          selection.sessions.map((session) => session.scopeId),
        ).size,
        ingested_session_count: selection.sessions.length,
        embedding_indexes: result.embeddingIndexes.length,
      };
    },
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
