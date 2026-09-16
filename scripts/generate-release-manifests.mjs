#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = "v1.0.0";
const check = process.argv.includes("--check");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalized(path) {
  return path.split("\\").join("/");
}

function walk(directory, include) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    const rel = normalized(relative(root, path));
    if (stat.isDirectory()) {
      if (include(rel, true)) files.push(...walk(path, include));
    } else if (stat.isFile() && include(rel, false)) {
      files.push({
        path: rel,
        size_bytes: stat.size,
        sha256: sha256(path),
      });
    }
  }
  return files;
}

function generated(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
      throw new Error(`Generated manifest is stale: ${normalized(relative(root, path))}`);
    }
    return;
  }
  writeFileSync(path, serialized, "utf8");
}

const experimentManifestPath = join(root, "experiments", "ARTIFACT_MANIFEST.json");
const experimentFiles = walk(join(root, "experiments"), (rel, directory) => {
  const parts = rel.split("/");
  if (parts.includes("__pycache__")) return false;
  if (!directory && /\.(?:pyc|pyo|DS_Store)$/u.test(rel)) return false;
  if (rel === "experiments/ARTIFACT_MANIFEST.json") return false;
  if (rel.endsWith("/single-file-qa/download-check.zip")) return false;
  return true;
});

generated(experimentManifestPath, {
  schema_version: 1,
  product: "Picorer",
  release,
  release_date: "2026-09-16",
  policy: "Canonical Picorer v1.0.0 experiment artifacts; measurements are unchanged.",
  excluded: [
    {
      path: "fact-mh-rq1-rq2-20260914/raw-terminal-artifacts.json.gz",
      reason: "Unreleased raw terminal-request archive.",
    },
    {
      path: "sufficiency-interventions-20260914/synthesis/__pycache__/build_single_file.cpython-312.pyc",
      reason: "Generated interpreter cache.",
    },
    {
      path: "sufficiency-interventions-20260914/synthesis/single-file-qa/download-check.zip",
      reason: "Redundant QA bundle; its constituent artifacts are released individually.",
    },
  ],
  files: experimentFiles.map(({ path, ...metadata }) => ({
    path: path.replace(/^experiments\//u, ""),
    ...metadata,
  })),
});

const releaseManifestPath = join(root, "docs", "picorer-v1.0.0", "RELEASE_MANIFEST.json");
const releaseFiles = walk(root, (rel, directory) => {
  const parts = rel.split("/");
  if ([".git", "node_modules", "dist", "experiments"].includes(parts[0])) return false;
  if (parts.includes("__pycache__")) return false;
  if (!directory && /(?:\.py[co]|\.log|\.sqlite(?:-shm|-wal)?|\.DS_Store)$/u.test(rel)) {
    return false;
  }
  if (rel === "docs/picorer-v1.0.0/RELEASE_MANIFEST.json") return false;
  return true;
});

generated(releaseManifestPath, {
  schema_version: 1,
  product: "Picorer",
  release,
  release_date: "2026-09-16",
  repository: "https://github.com/fendss/picorer",
  release_kind: "initial-independent-public-release",
  experiment_manifest: "experiments/ARTIFACT_MANIFEST.json",
  files: releaseFiles,
});

console.log(
  `${check ? "verified" : "generated"} ${String(releaseFiles.length)} release files and ` +
  `${String(experimentFiles.length)} experiment artifacts`,
);
