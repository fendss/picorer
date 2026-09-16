import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryRecord, ScopeExport } from "../../memory/index.js";
import { safePathSegment } from "../../util.js";

/** Reuse only an exact, regular-file export of this immutable source snapshot. */
async function verifyExistingExport(
  directory: string,
  stagingPath: string,
  paths: Iterable<string>,
): Promise<void> {
  const remaining = new Set(paths);
  const mismatch = () => new Error("Existing scope export does not match the immutable source snapshot");
  const visit = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      if (!prefix && entry.name === "sessions" && entry.isDirectory()) {
        await visit("sessions");
        continue;
      }
      const path = join(prefix, entry.name);
      if (!entry.isFile() || !remaining.has(path)) throw mismatch();
      const [actual, expected] = await Promise.all([
        readFile(join(directory, path)),
        readFile(join(stagingPath, path)),
      ]);
      if (!actual.equals(expected)) throw mismatch();
      remaining.delete(path);
    }
  };
  await visit("");
  if (remaining.size) throw mismatch();
}

/** Atomically publishes the unchanged source files used by read-only navigation. */
export async function exportMemoryScope(
  scopeId: string,
  records: readonly MemoryRecord[],
  exportRoot: string,
): Promise<ScopeExport> {
  if (records.length === 0) throw new Error(`Cannot export empty memory scope: ${scopeId}`);
  const bySession = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    if (record.scopeId !== scopeId) throw new Error(`Cannot export mixed memory scope: ${scopeId}`);
    const bucket = bySession.get(record.sessionId) ?? [];
    bucket.push(record);
    bySession.set(record.sessionId, bucket);
  }
  const jsonl = (items: readonly MemoryRecord[]) => items.map((record) => JSON.stringify(record)).join("\n") + "\n";
  // Render one file at a time; do not retain a second serialized copy of the corpus.
  const files = new Map<string, () => string>([
    ["manifest.json", () => `${JSON.stringify({
      schemaVersion: 1, scopeId, memoryCount: records.length, sessions: [...bySession.keys()],
    }, null, 2)}\n`],
    ["memory.jsonl", () => jsonl(records)],
    ["timeline.tsv", () => [
      "timestamp\tsession_id\tturn_index\tmemory_id\trole",
      ...records.map((record) => [record.timestamp ?? "", record.sessionId, record.turnIndex, record.memoryId, record.role].join("\t")),
    ].join("\n") + "\n"],
    ...[...bySession].map(([sessionId, sessionRecords]): [string, () => string] => [
      join("sessions", `${safePathSegment(sessionId)}.jsonl`), () => jsonl(sessionRecords),
    ]),
  ]);
  const scopePath = join(exportRoot, safePathSegment(scopeId));
  await mkdir(exportRoot, { recursive: true });
  const stagingPath = await mkdtemp(join(exportRoot, ".scope-"));
  let published = false;
  try {
    await mkdir(join(stagingPath, "sessions"));
    for (const [path, render] of files) {
      await writeFile(join(stagingPath, path), render(), "utf8");
    }
    try {
      await rename(stagingPath, scopePath);
      published = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error &&
          (error.code === "EEXIST" || error.code === "ENOTEMPTY"))) throw error;
      await verifyExistingExport(scopePath, stagingPath, files.keys());
    }
  } finally {
    if (!published) await rm(stagingPath, { recursive: true, force: true });
  }
  return { scopeId, path: scopePath, memoryCount: records.length };
}
