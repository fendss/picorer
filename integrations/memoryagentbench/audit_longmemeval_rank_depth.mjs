#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { MemoryStore } from "../../dist/platform/sqlite/picorer-store.js";
import { HybridRetriever } from "../../dist/retrieval/operators/hybrid-search.js";
import { SqliteExactDenseRetriever } from "../../dist/retrieval/adapters/sqlite/exact-dense-retriever.js";
import { OpenAICompatibleEmbedder } from "../../dist/retrieval/adapters/openai/openai-compatible-embedder.js";

const TARGET_STAGES = new Set([
  "partial_gold_candidates",
  "no_gold_candidate",
]);
const DEPTHS = [20, 40, 80, 100];

function usage() {
  throw new Error(
    "usage: audit_longmemeval_rank_depth.mjs DIAGNOSTIC ARTIFACT AUDIT_JSONL SQLITE OUTPUT",
  );
}

function scopeFromAudit(audit) {
  for (const evidence of audit.retrieval?.evidence ?? []) {
    if (typeof evidence.scopeId === "string") return evidence.scopeId;
  }
  for (const step of audit.retrieval?.trace ?? []) {
    for (const candidate of step.details?.candidates ?? []) {
      if (typeof candidate.scopeId === "string") return candidate.scopeId;
    }
  }
  throw new Error(`cannot resolve scope for wrap ${audit.wrap_id ?? "unknown"}`);
}

function successfulSearches(audit) {
  return (audit.retrieval?.trace ?? []).filter((step) =>
    step.toolName === "search" && step.isError === false &&
    step.details?.kind === "search"
  );
}

function covers(groups, ids) {
  return groups.every((group) => group.some((memoryId) => ids.has(memoryId)));
}

function coversAny(groups, ids) {
  return groups.some((group) => group.some((memoryId) => ids.has(memoryId)));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

class CachedEmbedder {
  constructor(inner, vectors) {
    this.inner = inner;
    this.vectors = vectors;
    this.profileId = inner.profileId;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.maxInputLength = inner.maxInputLength;
    this.batchSize = inner.batchSize;
  }

  embedQueries(texts) {
    return Promise.resolve(texts.map((text) => {
      const vector = this.vectors.get(text);
      if (vector === undefined) throw new Error(`uncached query: ${text}`);
      return vector;
    }));
  }

  embedDocuments(texts) {
    return this.embedQueries(texts);
  }

  snapshotMetrics() {
    return this.inner.snapshotMetrics();
  }
}

async function main() {
  if (process.argv.length !== 7) usage();
  const [, , diagnosticPath, artifactPath, auditPath, sqlitePath, outputPath] = process.argv;
  const [diagnostic, artifact, auditText] = await Promise.all([
    readFile(diagnosticPath, "utf8").then(JSON.parse),
    readFile(artifactPath, "utf8").then(JSON.parse),
    readFile(auditPath, "utf8"),
  ]);
  const artifactRows = new Map(
    artifact.data.map((row) => [row.benchmark_query_id, row]),
  );
  const questionToId = new Map(
    artifact.data.map((row) => [row.query, row.benchmark_query_id]),
  );
  const targetRows = diagnostic.rows.filter((row) => TARGET_STAGES.has(row.stage));
  const targetIds = new Set(targetRows.map((row) => row.benchmark_query_id));
  const audits = new Map();
  for (const line of auditText.split(/\r?\n/u)) {
    if (!line) continue;
    const audit = JSON.parse(line);
    const queryId = questionToId.get(audit.question);
    if (targetIds.has(queryId)) audits.set(queryId, audit);
  }
  if (audits.size !== targetRows.length) {
    throw new Error(`resolved ${audits.size}/${targetRows.length} target audits`);
  }

  const queryTexts = sortedUnique(targetRows.flatMap((row) =>
    successfulSearches(audits.get(row.benchmark_query_id)).flatMap((step) =>
      step.details.request.queries
    )
  ));
  const baseEmbedder = OpenAICompatibleEmbedder.fromEnvironment();
  const queryVectors = await baseEmbedder.embedQueries(queryTexts);
  const cachedEmbedder = new CachedEmbedder(
    baseEmbedder,
    new Map(queryTexts.map((query, index) => [query, queryVectors[index]])),
  );
  const rawStore = new MemoryStore(sqlitePath);
  const hybridStore = new HybridRetriever(
    rawStore,
    cachedEmbedder,
    new SqliteExactDenseRetriever(rawStore),
  );
  const rows = [];
  try {
    for (const target of targetRows) {
      const queryId = target.benchmark_query_id;
      const artifactRow = artifactRows.get(queryId);
      const audit = audits.get(queryId);
      const scopeId = scopeFromAudit(audit);
      const searches = successfulSearches(audit);
      const callRows = [];
      for (const step of searches) {
        const request = step.details.request;
        const operator = step.details.operator;
        if (operator !== "hybrid" && operator !== "lexical") {
          throw new Error(`unsupported operator ${operator} in ${queryId}`);
        }
        const execute = (nextRequest) => operator === "hybrid"
          ? hybridStore.search(scopeId, nextRequest)
          : Promise.resolve(rawStore.search(scopeId, nextRequest));
        const [originalHits, ...depthHits] = await Promise.all([
          execute(request),
          ...DEPTHS.map((depth) => execute({ ...request, limit: depth })),
        ]);
        const actualIds = (step.details.candidates ?? []).map((item) => item.memoryId);
        const replayIds = originalHits.map((hit) => hit.record.memoryId);
        callRows.push({
          step: step.step,
          operator,
          queries: request.queries,
          original_limit: request.limit,
          actual_ids: actualIds,
          replay_ids: replayIds,
          exact_original_replay: JSON.stringify(actualIds) === JSON.stringify(replayIds),
          actual_replay_overlap: actualIds.filter((id) => replayIds.includes(id)).length,
          depth_ids: Object.fromEntries(DEPTHS.map((depth, index) => [
            `top_${depth}`,
            depthHits[index].map((hit) => hit.record.memoryId),
          ])),
        });
      }
      const actualUnion = new Set(callRows.flatMap((call) => call.actual_ids));
      const coverage = {};
      for (const depth of DEPTHS) {
        const ids = new Set(callRows.flatMap((call) => call.depth_ids[`top_${depth}`]));
        coverage[`top_${depth}`] = {
          candidate_count: ids.size,
          gold_any: coversAny(target.gold_source_groups, ids),
          gold_all: covers(target.gold_source_groups, ids),
          covered_groups: target.gold_source_groups.filter((group) =>
            group.some((id) => ids.has(id))
          ).length,
        };
      }
      const goldGroupRanks = target.gold_source_groups.map((group) => {
        const ranks = callRows.flatMap((call) => group.flatMap((id) => {
          const index = call.depth_ids.top_100.indexOf(id);
          return index < 0 ? [] : [index + 1];
        }));
        return ranks.length === 0 ? null : Math.min(...ranks);
      });
      const profile = {
        profileId: cachedEmbedder.profileId,
        model: cachedEmbedder.model,
        dimensions: cachedEmbedder.dimensions,
      };
      const scopeStatus = rawStore.getEmbeddingIndexStatus(scopeId, profile);
      rows.push({
        benchmark_query_id: queryId,
        question_type: target.question_type,
        question: artifactRow.query,
        original_stage: target.stage,
        scope_id: scopeId,
        scope_memory_count: scopeStatus.total,
        gold_source_groups: target.gold_source_groups,
        original_candidate_count: actualUnion.size,
        original_gold_all: covers(target.gold_source_groups, actualUnion),
        gold_group_best_ranks: goldGroupRanks,
        coverage,
        calls: callRows,
      });
    }
  } finally {
    rawStore.close();
  }

  const summary = {
    targets: rows.length,
    stages: Object.fromEntries([...TARGET_STAGES].map((stage) => [
      stage,
      rows.filter((row) => row.original_stage === stage).length,
    ])),
    search_calls: rows.reduce((sum, row) => sum + row.calls.length, 0),
    operators: Object.fromEntries(["hybrid", "lexical"].map((operator) => [
      operator,
      rows.flatMap((row) => row.calls).filter((call) => call.operator === operator).length,
    ])),
    exact_original_replays: rows.flatMap((row) => row.calls)
      .filter((call) => call.exact_original_replay).length,
    same_original_candidate_set_replays: rows.flatMap((row) => row.calls)
      .filter((call) =>
        call.actual_ids.length === call.replay_ids.length &&
        call.actual_ids.every((id) => call.replay_ids.includes(id))
      ).length,
    depth_recovery: Object.fromEntries(DEPTHS.map((depth) => [
      `top_${depth}`,
      {
        gold_all_queries: rows.filter((row) => row.coverage[`top_${depth}`].gold_all).length,
        gold_any_queries: rows.filter((row) => row.coverage[`top_${depth}`].gold_any).length,
      },
    ])),
    absent_by_top_100_groups: rows.reduce(
      (sum, row) => sum + row.gold_group_best_ranks.filter((rank) => rank === null).length,
      0,
    ),
    queries_not_fully_recovered_by_top_100: rows
      .filter((row) => !row.coverage.top_100.gold_all)
      .map((row) => row.benchmark_query_id),
    embedding: {
      profile_id: cachedEmbedder.profileId,
      model: cachedEmbedder.model,
      dimensions: cachedEmbedder.dimensions,
      unique_queries: queryTexts.length,
      metrics: baseEmbedder.snapshotMetrics(),
    },
  };
  const output = {
    schema_version: 1,
    diagnostic: diagnosticPath,
    artifact: artifactPath,
    audit: auditPath,
    sqlite: sqlitePath,
    depths: DEPTHS,
    summary,
    rows,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
}

await main();
