import { join, resolve } from "node:path";

export interface EvidenceBenchmarkDataPaths {
  database: string;
  sanitized: string;
  privateQueries: string;
  privateLabels: string;
  datasetManifest: string;
}

/** Filesystem layout shared by evidence-based benchmark adapters. */
export function evidenceBenchmarkDataPaths(
  dataDir: string,
): EvidenceBenchmarkDataPaths {
  const root = resolve(dataDir);
  return {
    database: join(root, "memory.sqlite"),
    sanitized: join(root, "sanitized"),
    privateQueries: join(root, "private", "queries.jsonl"),
    privateLabels: join(root, "private", "labels.jsonl"),
    datasetManifest: join(root, "dataset-manifest.json"),
  };
}
