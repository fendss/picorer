import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemorySessionInput } from "../../memory/index.js";

export type MemoryAgentBenchTask =
  | "ruler_qa"
  | "eventqa"
  | "longmemeval"
  | "factconsolidation"
  | "in_context_learning";

export type MemoryAgentBenchTrack = "refind-comparable" | "ttl-extension";

export interface MemoryAgentBenchQuestion {
  questionId: string;
  scopeId: string;
  contextId: string;
  sequence: number;
  question: string;
  task: MemoryAgentBenchTask;
  track: MemoryAgentBenchTrack;
  upstreamQaId: string;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function integerAt(
  object: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path}.${key} must be a non-negative integer`);
  }
  return value as number;
}

function jsonLines(source: string, path: string): unknown[] {
  return source.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${path}:${String(index + 1)} is not valid JSON`);
    }
  });
}

export async function readMemoryAgentBenchQuestions(
  inputRoot: string,
  subset: string,
): Promise<MemoryAgentBenchQuestion[]> {
  const path = join(inputRoot, "public", "questions", `${subset}.jsonl`);
  const source = await readFile(path, "utf8");
  const questions = jsonLines(source, path).map((value, index) => {
    const item = objectAt(value, `${path}:${String(index + 1)}`);
    const task = stringAt(item, "task", path);
    const track = stringAt(item, "track", path);
    if (!new Set<MemoryAgentBenchTask>([
      "ruler_qa",
      "eventqa",
      "longmemeval",
      "factconsolidation",
      "in_context_learning",
    ]).has(task as MemoryAgentBenchTask)) {
      throw new Error(`${path}: unknown task ${task}`);
    }
    if (track !== "refind-comparable" && track !== "ttl-extension") {
      throw new Error(`${path}: unknown track ${track}`);
    }
    return {
      questionId: stringAt(item, "questionId", path),
      scopeId: stringAt(item, "scopeId", path),
      contextId: stringAt(item, "contextId", path),
      sequence: integerAt(item, "sequence", path),
      question: stringAt(item, "question", path),
      task: task as MemoryAgentBenchTask,
      track: track as MemoryAgentBenchTrack,
      upstreamQaId: stringAt(item, "upstreamQaId", path),
    };
  });
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.questionId)) {
      throw new Error(`Duplicate MemoryAgentBench question ID ${question.questionId}`);
    }
    ids.add(question.questionId);
  }
  return questions;
}

export async function readMemoryAgentBenchSessions(
  inputRoot: string,
  subset: string,
  contextId: string,
): Promise<MemorySessionInput[]> {
  const contextName = contextId.split("/").at(-1);
  if (!contextName || !/^c\d{3}$/u.test(contextName)) {
    throw new Error(`Invalid MemoryAgentBench context ID ${contextId}`);
  }
  const path = join(
    inputRoot,
    "public",
    "contexts",
    subset,
    `${contextName}.jsonl`,
  );
  const source = await readFile(path, "utf8");
  return jsonLines(source, path) as MemorySessionInput[];
}
