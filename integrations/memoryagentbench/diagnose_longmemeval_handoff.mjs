#!/usr/bin/env node

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { renderMemoryArenaEvidencePrompt } from
  "../../dist/benchmark/memoryarena-public/index.js";
import {
  judge,
  officialAnswerText,
  officialLongMemEvalPrompt,
  originalLongMemEvalQuestion,
} from "./evaluate_longmemeval_official.mjs";
import { loadMemoryAgentBenchYaml } from "./run_from_yaml.mjs";

const ANSWER_SYSTEM_PROMPT =
  "You are a helpful assistant that can read the context and memorize it for future retrieval.";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rowsById(document) {
  return new Map(document.data.map((row) => [row.benchmark_query_id, row]));
}

function withoutRetrievalGuidance(prompt) {
  return prompt
    .replace(/<retrieval_package>[\s\S]*?<\/retrieval_package>\n?/u, "")
    .replace(/<retrieval_summary[^>]*>[\s\S]*?<\/retrieval_summary>\n?/u, "");
}

function renderFullSelectedPrompt(question, chunks) {
  return [
    "<memory_context>",
    ...(chunks.length === 0
      ? ["None"]
      : chunks.map((chunk) => `<memory>${chunk}</memory>`)),
    "</memory_context>",
    `User: ${question}`,
  ].join("\n");
}

async function completion({ baseUrl, apiKey, model, thinkingLevel, maxTokens, prompt }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: ANSWER_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          reasoning_effort: thinkingLevel,
          max_completion_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        if (response.status < 500 && ![408, 409, 425, 429].includes(response.status)) {
          throw new Error(`non-retryable answer HTTP ${String(response.status)}`);
        }
        throw new Error(`retryable answer HTTP ${String(response.status)}`);
      }
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("retryable empty answer response");
      }
      return {
        content: content.trim(),
        model: typeof body.model === "string" ? body.model : model,
        attempts,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("non-retryable")) throw error;
      const delay = Math.min(2 ** Math.min(attempts - 1, 5), 30) * 1000;
      await new Promise((done) => setTimeout(done, delay + Math.random() * 500));
    }
  }
}

async function runPool(units, concurrency, operation) {
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, units.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= units.length) return;
        await operation(units[index], index);
      }
    },
  ));
}

async function currentAudits(path, queryIds, cutoff) {
  const result = new Map();
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const audit = JSON.parse(line);
    const queryId = audit.operatorExperiment?.questionId;
    if (
      typeof queryId === "string" &&
      queryIds.has(queryId) &&
      typeof audit.created_at === "string" &&
      audit.created_at >= cutoff
    ) {
      result.set(queryId, audit);
    }
  }
  return result;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const [
    configPath,
    sourceArtifactPath,
    oldJudgePath,
    newJudgePath,
    auditPath,
    databasePath,
    outputPath,
    rawConcurrency = "32",
    cutoff = "2026-08-28",
    scope = "lost",
    variantSelection = "both",
  ] = process.argv.slice(2);
  if (!outputPath) {
    throw new Error(
      "Usage: diagnose_longmemeval_handoff.mjs CONFIG SOURCE OLD_JUDGE NEW_JUDGE " +
      "WRAP_AUDIT SQLITE OUTPUT [CONCURRENCY] [CUTOFF] [lost|all] " +
      "[both|exact|full|guided]",
    );
  }
  const concurrency = Number(rawConcurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) {
    throw new Error("CONCURRENCY must be an integer between 1 and 128");
  }
  if (!["lost", "all"].includes(scope)) {
    throw new Error("Scope must be lost or all");
  }
  if (!["both", "exact", "full", "guided"].includes(variantSelection)) {
    throw new Error("Variant selection must be both, exact, full, or guided");
  }

  const config = loadMemoryAgentBenchYaml(configPath);
  const source = rowsById(readJson(resolve(sourceArtifactPath)));
  const oldJudge = rowsById(readJson(resolve(oldJudgePath)));
  const newJudge = rowsById(readJson(resolve(newJudgePath)));
  const selectedIds = new Set([...oldJudge].flatMap(([id, oldRow]) =>
    scope === "all" || (oldRow.label === true && newJudge.get(id)?.label === false)
      ? [id]
      : []));
  const audits = await currentAudits(resolve(auditPath), selectedIds, cutoff);
  if (audits.size !== selectedIds.size) {
    throw new Error(
      `Expected ${String(selectedIds.size)} current audits, found ${String(audits.size)}`,
    );
  }

  const database = new DatabaseSync(resolve(databasePath), { readOnly: true });
  const sourceById = database.prepare(
    "SELECT content, content_hash FROM memories WHERE memory_id = ?",
  );
  const units = [];
  for (const queryId of [...selectedIds].sort()) {
    const audit = audits.get(queryId);
    const sourceRow = source.get(queryId);
    const fullChunks = audit.selectedMemoryIds.map((memoryId) => {
      const row = sourceById.get(memoryId);
      if (row === undefined) throw new Error(`Missing selected memory ${memoryId}`);
      const committed = audit.retrieval.evidence.find((item) => item.memoryId === memoryId);
      if (committed !== undefined && committed.sourceContentHash !== row.content_hash) {
        throw new Error(`Selected memory changed after retrieval: ${memoryId}`);
      }
      return row.content;
    });
    const variants = {
      ...(variantSelection === "both" || variantSelection === "exact"
        ? { exact_without_guidance: withoutRetrievalGuidance(audit.prompt) }
        : {}),
      ...(variantSelection === "both" || variantSelection === "full"
        ? {
            full_selected_without_guidance:
              renderFullSelectedPrompt(audit.question, fullChunks),
          }
        : {}),
      ...(variantSelection === "guided"
        ? {
            evidence_aware: renderMemoryArenaEvidencePrompt(
              audit.question,
              audit.retrieval,
            ),
          }
        : {}),
    };
    units.push({
      queryId,
      sourceRow,
      variants,
    });
  }
  database.close();

  const rows = [];
  const persist = () => writeJsonAtomic(resolve(outputPath), {
    schema_version: 1,
    experiment: "longmemeval-handoff-counterfactual",
    source_artifact: resolve(sourceArtifactPath),
    old_judge: resolve(oldJudgePath),
    new_judge: resolve(newJudgePath),
    scope,
    variant_selection: variantSelection,
    selected_queries: units.length,
    data: [...rows].sort((left, right) =>
      left.benchmark_query_id.localeCompare(right.benchmark_query_id) ||
      left.variant.localeCompare(right.variant)),
  });
  await persist();

  const work = units.flatMap((unit) => Object.entries(unit.variants).map(
    ([variant, prompt]) => ({ ...unit, variant, prompt }),
  ));
  let completed = 0;
  await runPool(work, concurrency, async (unit) => {
    const answer = await completion({
      baseUrl: config.credentials.generation.baseUrl,
      apiKey: config.credentials.generation.apiKey,
      model: config.models.answer.id,
      thinkingLevel: config.models.answer.thinkingLevel,
      maxTokens: config.models.answer.maxTokens,
      prompt: unit.prompt,
    });
    const judged = await judge({
      baseUrl: config.credentials.generation.baseUrl,
      apiKey: config.credentials.generation.apiKey,
      model: "gpt-4o",
      prompt: officialLongMemEvalPrompt(
        unit.sourceRow.question_type,
        originalLongMemEvalQuestion(unit.sourceRow.query),
        officialAnswerText(unit.sourceRow.answer),
        answer.content,
        String(unit.sourceRow.question_id).includes("_abs"),
      ),
    });
    rows.push({
      benchmark_query_id: unit.queryId,
      question_type: unit.sourceRow.question_type,
      variant: unit.variant,
      output: answer.content,
      label: judged.label,
      answer_model: answer.model,
      answer_attempts: answer.attempts,
      judge_model: judged.responseModel,
      judge_attempts: judged.attempts,
      prompt_chars: unit.prompt.length,
    });
    completed += 1;
    if (completed % 10 === 0 || completed === work.length) {
      await persist();
      process.stdout.write(`${JSON.stringify({ completed, total: work.length })}\n`);
    }
  });
  await persist();
  for (const variant of Object.keys(units[0]?.variants ?? {})) {
    const selected = rows.filter((row) => row.variant === variant);
    const correct = selected.filter((row) => row.label).length;
    process.stdout.write(`${JSON.stringify({
      variant,
      correct,
      total: selected.length,
      accuracy: correct / selected.length,
    })}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
