import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  loadPinnedTauKnowledgeCheckout,
  tauKnowledgeDataPaths,
} from "../../../benchmark/tau-knowledge/index.js";
import { ingestEvidenceBenchmark } from "../../../benchmark/composition/ingest-evidence-benchmark.js";
import {
  assertOnlyFlags,
  positiveIntegerFlag,
  positiveNumberFlag,
  requiredFlag,
  retrievalProfileFor,
  type ParsedCommand,
} from "../parse-command.js";
import {
  readJsonFileIfPresent,
  writeAtomicJson,
} from "../workflow-files.js";

interface TauKnowledgeManifest {
  schema_version: 1;
  benchmark: "tau-knowledge";
  source: Record<string, unknown>;
  scope_id: string;
  document_count: number;
  task_count: number;
  corpus_hash: string;
  task_set_hash: string;
  retrieval: unknown;
}

async function withDataDirectoryLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = resolve(root, ".ingest.lock");
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

export async function ingestTauKnowledge(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "tau-root",
    "data-dir",
    "retrieval-profile",
    "embedding-slots",
    "embedding-rps",
  ]);
  const tauRoot = resolve(requiredFlag(parsed, "tau-root"));
  const paths = tauKnowledgeDataPaths(requiredFlag(parsed, "data-dir"));
  const retrievalProfile = retrievalProfileFor(parsed);
  const embeddingSlots = positiveIntegerFlag(parsed, "embedding-slots", 1, 64);
  const embeddingRps = positiveNumberFlag(parsed, "embedding-rps", 6, 1000);

  await withDataDirectoryLock(dirname(paths.database), async () => {
    const dataset = await loadPinnedTauKnowledgeCheckout(tauRoot);
    const existing = await readJsonFileIfPresent<TauKnowledgeManifest>(
      paths.manifest,
    );
    if (
      existing !== undefined &&
      (
        existing.schema_version !== 1 ||
        existing.benchmark !== "tau-knowledge" ||
        existing.scope_id !== dataset.scopeId ||
        existing.corpus_hash !== dataset.documentsHash ||
        existing.task_set_hash !== dataset.tasksHash
      )
    ) {
      throw new Error("Data directory belongs to a different tau-Knowledge dataset");
    }
    if (
      existing !== undefined &&
      typeof existing.retrieval === "object" && existing.retrieval !== null &&
      "retrievalProfile" in existing.retrieval &&
      existing.retrieval.retrievalProfile !== retrievalProfile
    ) {
      throw new Error("tau-Knowledge retrieval profile cannot change in-place");
    }
    const ingested = await ingestEvidenceBenchmark({
      paths,
      sessions: dataset.sessions,
      retrievalProfile,
      embeddingSlots,
      embeddingRequestsPerSecond: embeddingRps,
      onScopeSettled(progress) {
        process.stderr.write(
          `[embedding slot ${progress.slot}] [${progress.settled}/${progress.total}] ` +
            `${progress.scopeId}\n`,
        );
      },
    });
    const manifest: TauKnowledgeManifest = {
      schema_version: 1,
      benchmark: "tau-knowledge",
      source: dataset.identity,
      scope_id: dataset.scopeId,
      document_count: dataset.sessions.length,
      task_count: dataset.identity.taskCount,
      corpus_hash: dataset.documentsHash,
      task_set_hash: dataset.tasksHash,
      retrieval: ingested.retrieval,
    };
    await writeAtomicJson(paths.manifest, manifest);
    process.stdout.write(`${JSON.stringify({
      command: "ingest-tau-knowledge",
      tau_root: tauRoot,
      data_dir: paths.root,
      scope_id: dataset.scopeId,
      documents: dataset.sessions.length,
      tasks: dataset.identity.taskCount,
      scopes: ingested.scopes,
      retrieval: ingested.retrieval,
      embedding_indexes: ingested.embeddingIndexes,
      manifest: paths.manifest,
    }, null, 2)}\n`);
  });
}
