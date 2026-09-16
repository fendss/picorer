#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAsyncPool } from "../dist/platform/concurrency/async-pool.js";
import { AsyncRequestGate } from "../dist/platform/concurrency/request-gate.js";
import { MemoryStore } from "../dist/platform/sqlite/picorer-store.js";
import { OpenAICompatibleEmbedder } from "../dist/retrieval/adapters/openai/openai-compatible-embedder.js";
import {
  embeddingProfile,
  indexScopeEmbeddings,
} from "../dist/retrieval/index-scope-embeddings.js";

function options(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Expected --data-dir DIR [--slots N] [--rps N]");
    }
    values.set(name.slice(2), value);
  }
  const dataDir = values.get("data-dir");
  if (!dataDir) throw new Error("--data-dir is required");
  const positive = (name, fallback) => {
    const parsed = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };
  return {
    dataDir: resolve(dataDir),
    slots: positive("slots", 6),
    rps: positive("rps", 6),
  };
}

const selected = options(process.argv.slice(2));
const questions = (await readFile(
  resolve(selected.dataDir, "private/questions.jsonl"),
  "utf8",
)).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const scopeIds = [...new Set(questions.map((question) => question.scopeId))]
  .sort();
if (scopeIds.length === 0) throw new Error("No stored scopes found");

const gate = new AsyncRequestGate(selected.slots, selected.rps);
const embedders = Array.from({ length: selected.slots }, () =>
  OpenAICompatibleEmbedder.fromEnvironment(process.env, undefined, gate)
);
const profile = embeddingProfile(embedders[0]);
const store = await MemoryStore.create(resolve(selected.dataDir, "memory.sqlite"));
let settled = 0;
try {
  const results = await runAsyncPool(
    scopeIds,
    selected.slots,
    async (scopeId, context) => {
      const result = await indexScopeEmbeddings(
        store,
        scopeId,
        embedders[context.slot - 1],
      );
      settled += 1;
      process.stderr.write(
        `[embedding slot ${context.slot}] [${settled}/${scopeIds.length}] ` +
          `${scopeId}: ${result.indexed}/${result.total}\n`,
      );
      return result;
    },
  );
  process.stdout.write(`${JSON.stringify({
    profile,
    scopes: scopeIds.length,
    memories: results.reduce((sum, result) => sum + result.total, 0),
    indexed_now: results.reduce((sum, result) => sum + result.indexedNow, 0),
    missing: results.reduce((sum, result) => sum + result.missing, 0),
  }, null, 2)}\n`);
} finally {
  store.close();
}
