import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertOnlyFlags,
  requiredFlag,
  type ParsedCommand,
} from "../parse-command.js";
import {
  executeArchiveCommand,
  writeAtomicJson,
} from "../workflow-files.js";

function jsonlRecordCount(serialized: string): number {
  return serialized.split("\n").filter(Boolean).length;
}

export async function packageBenchmark(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, ["output-dir", "archive"]);
  const outputDir = resolve(requiredFlag(parsed, "output-dir"));
  const archivePath = resolve(requiredFlag(parsed, "archive"));
  const includedFiles = [
    "run-manifest.json",
    "results.json",
    "predictions.jsonl",
    "traces.jsonl",
  ];
  for (const optional of ["suite-audit.json", "benchmark-progress.json"]) {
    try {
      const metadata = await stat(join(outputDir, optional));
      if (metadata.isFile()) includedFiles.push(optional);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const [manifestText, resultsText, predictionsText, tracesText, failuresText] =
    await Promise.all([
      readFile(join(outputDir, includedFiles[0]!), "utf8"),
      readFile(join(outputDir, includedFiles[1]!), "utf8"),
      readFile(join(outputDir, includedFiles[2]!), "utf8"),
      readFile(join(outputDir, includedFiles[3]!), "utf8"),
      readFile(join(outputDir, "failures.jsonl"), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText) as {
    config?: { question_count?: unknown };
  };
  const results = JSON.parse(resultsText) as {
    result_count?: unknown;
    results?: unknown[];
  };
  const expected = manifest.config?.question_count;
  if (!Number.isSafeInteger(expected) || expected !== results.result_count) {
    throw new Error("Benchmark results are incomplete for the manifest question set");
  }
  if (!Array.isArray(results.results) || results.results.length !== expected) {
    throw new Error("Benchmark results array is incomplete");
  }
  if (
    jsonlRecordCount(predictionsText) !== expected ||
    jsonlRecordCount(tracesText) !== expected
  ) {
    throw new Error("Benchmark JSONL artifacts are incomplete");
  }
  if (jsonlRecordCount(failuresText) !== 0) {
    throw new Error("Benchmark has unresolved failures and cannot be packaged");
  }

  const files = await Promise.all(
    includedFiles.map(async (name) => {
      const content = await readFile(join(outputDir, name));
      return {
        path: name,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  await writeAtomicJson(join(outputDir, "package-manifest.json"), {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    question_count: expected,
    files,
  });
  includedFiles.push("package-manifest.json");

  const archiveDirectory = dirname(archivePath);
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const temporaryArchive = `${archivePath}.tmp-${process.pid}-${randomUUID()}`;
  await executeArchiveCommand("/usr/bin/tar", [
    "-czf",
    temporaryArchive,
    "-C",
    outputDir,
    ...includedFiles,
  ]);
  await chmod(temporaryArchive, 0o600);
  await rename(temporaryArchive, archivePath);
  const archiveStat = await stat(archivePath);
  process.stdout.write(
    `${JSON.stringify({
      command: "package-benchmark",
      questionCount: expected,
      archivePath,
      archiveBytes: archiveStat.size,
    }, null, 2)}\n`,
  );
}
