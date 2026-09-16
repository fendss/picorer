import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalPrivateQuestion } from "../src/benchmark/longmemeval/dataset-adapter.js";
import {
  benchmarkCorpusHash,
  benchmarkModelOptionsFor,
  benchmarkQuestionSetHash,
  benchmarkSourceRevision,
} from "../src/entrypoints/cli/evidence-benchmark-runtime.js";
import {
  suiteBenchmarkEnvironment,
  suiteModelConfigurationFor,
} from "../src/entrypoints/cli/commands/longmemeval-suite.js";
import { parseCommand } from "../src/entrypoints/cli/parse-command.js";
import { safePathSegment } from "../src/util.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

function question(overrides: Partial<LongMemEvalPrivateQuestion> = {}):
  LongMemEvalPrivateQuestion {
  return {
    questionId: "question-1",
    scopeId: "scope-1",
    question: "What color is the bicycle?",
    questionDate: "2026-01-01",
    ...overrides,
  };
}

describe("benchmark run identity", () => {
  it("configures suite roles through adapters without agent directories", () => {
    const parsed = parseCommand([
      "longmemeval-suite",
      "--model-adapter", "qwen-completions",
      "--provider", "siliconflow",
      "--model", "Qwen/Qwen3-32B",
      "--context-window", "32768",
      "--max-tokens", "8192",
      "--thinking-level", "high",
    ]);

    expect(suiteModelConfigurationFor(parsed)).toEqual({
      retrieval: {
        modelAdapter: "qwen-completions",
        provider: "siliconflow",
        model: "Qwen/Qwen3-32B",
        contextWindow: "32768",
        maxTokens: "8192",
        thinkingLevel: "high",
        apiKeySourceEnv: "OPENAI_API_KEY",
        baseUrlSourceEnv: "OPENAI_API_BASE",
        transport: "sse",
      },
      answer: {
        modelAdapter: "qwen-completions",
        provider: "siliconflow",
        model: "Qwen/Qwen3-32B",
        contextWindow: "32768",
        maxTokens: "8192",
        thinkingLevel: "high",
        apiKeySourceEnv: "OPENAI_API_KEY",
        baseUrlSourceEnv: "OPENAI_API_BASE",
        transport: "sse",
      },
    });
  });

  it("isolates suite retrieval and answer credentials with conventional names", () => {
    const parsed = parseCommand([
      "longmemeval-suite",
      "--retrieval-agent-dir", "/retrieval-agent",
      "--retrieval-provider", "retrieval-provider",
      "--retrieval-model", "gpt-5.4-mini",
      "--answer-agent-dir", "/answer-agent",
      "--answer-provider", "answer-provider",
      "--answer-model", "gpt-4o-mini",
      "--answer-transport", "non-stream",
    ]);
    const models = suiteModelConfigurationFor(parsed);
    expect(models).toMatchObject({
      retrieval: {
        provider: "retrieval-provider",
        model: "gpt-5.4-mini",
        transport: "sse",
      },
      answer: {
        provider: "answer-provider",
        model: "gpt-4o-mini",
        transport: "non-stream",
      },
    });

    const environment = suiteBenchmarkEnvironment({
      retrievalSource: {
        OPENAI_API_KEY: "retrieval-secret",
        OPENAI_API_BASE: "https://retrieval.example/v1",
      },
      answerSource: {
        OPENAI_API_KEY: "answer-secret",
        OPENAI_API_BASE: "https://answer.example/v1",
      },
      models,
    });
    expect(environment).toMatchObject({
      PICORER_RETRIEVAL_API_KEY: "retrieval-secret",
      PICORER_RETRIEVAL_BASE_URL: "https://retrieval.example/v1",
      PICORER_ANSWER_API_KEY: "answer-secret",
      PICORER_ANSWER_BASE_URL: "https://answer.example/v1",
      OPENAI_API_KEY: "answer-secret",
      OPENAI_API_BASE: "https://answer.example/v1",
      OPENAI_MODEL: "gpt-4o-mini",
    });
  });

  it("resolves independent retrieval and answer runtimes", () => {
    vi.stubEnv("SHARED_KEY", "shared-secret");
    vi.stubEnv("RETRIEVAL_KEY", "retrieval-secret");
    vi.stubEnv("ANSWER_KEY", "answer-secret");
    vi.stubEnv("SHARED_BASE", "https://shared.example/v1");
    vi.stubEnv("RETRIEVAL_BASE", "https://retrieval.example/v1");
    vi.stubEnv("ANSWER_BASE", "https://answer.example/v1");
    const parsed = parseCommand([
      "benchmark-longmemeval",
      "--agent-dir", "/shared-agent",
      "--provider", "shared-provider",
      "--model", "shared-model",
      "--thinking-level", "medium",
      "--api-key-env", "SHARED_KEY",
      "--base-url-env", "SHARED_BASE",
      "--transport", "sse",
      "--retrieval-agent-dir", "/retrieval-agent",
      "--retrieval-provider", "retrieval-provider",
      "--retrieval-model", "gpt-5.4-mini",
      "--retrieval-thinking-level", "high",
      "--retrieval-api-key-env", "RETRIEVAL_KEY",
      "--retrieval-base-url-env", "RETRIEVAL_BASE",
      "--retrieval-transport", "non-stream",
      "--answer-agent-dir", "/answer-agent",
      "--answer-provider", "answer-provider",
      "--answer-model", "gpt-4o-mini",
      "--answer-thinking-level", "off",
      "--answer-api-key-env", "ANSWER_KEY",
      "--answer-base-url-env", "ANSWER_BASE",
      "--answer-transport", "sse",
    ]);

    expect(benchmarkModelOptionsFor(parsed, "retrieval")).toEqual({
      agentDir: "/retrieval-agent",
      providerId: "retrieval-provider",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      apiKeyEnv: "RETRIEVAL_KEY",
      baseUrl: "https://retrieval.example/v1",
      transport: "non-stream",
    });
    expect(benchmarkModelOptionsFor(parsed, "answer")).toEqual({
      agentDir: "/answer-agent",
      providerId: "answer-provider",
      modelId: "gpt-4o-mini",
      thinkingLevel: "off",
      apiKeyEnv: "ANSWER_KEY",
      baseUrl: "https://answer.example/v1",
      transport: "sse",
    });
  });

  it("uses legacy model flags as field-by-field defaults for both stages", () => {
    vi.stubEnv("SHARED_KEY", "shared-secret");
    vi.stubEnv("SHARED_BASE", "https://shared.example/v1");
    const parsed = parseCommand([
      "benchmark-longmemeval",
      "--agent-dir", "/shared-agent",
      "--provider", "shared-provider",
      "--model", "shared-model",
      "--thinking-level", "medium",
      "--api-key-env", "SHARED_KEY",
      "--base-url-env", "SHARED_BASE",
      "--transport", "non-stream",
      "--answer-model", "gpt-4o-mini",
    ]);

    expect(benchmarkModelOptionsFor(parsed, "retrieval")).toEqual({
      agentDir: "/shared-agent",
      providerId: "shared-provider",
      modelId: "shared-model",
      thinkingLevel: "medium",
      apiKeyEnv: "SHARED_KEY",
      baseUrl: "https://shared.example/v1",
      transport: "non-stream",
    });
    expect(benchmarkModelOptionsFor(parsed, "answer")).toEqual({
      agentDir: "/shared-agent",
      providerId: "shared-provider",
      modelId: "gpt-4o-mini",
      thinkingLevel: "medium",
      apiKeyEnv: "SHARED_KEY",
      baseUrl: "https://shared.example/v1",
      transport: "non-stream",
    });
  });

  it("hashes complete question identity rather than IDs alone", () => {
    const original = benchmarkQuestionSetHash([question()]);
    expect(benchmarkQuestionSetHash([question()])).toBe(original);
    expect(benchmarkQuestionSetHash([
      question({ question: "What color is the car?" }),
    ])).not.toBe(original);
    expect(benchmarkQuestionSetHash([
      question({ questionDate: "2026-01-02" }),
    ])).not.toBe(original);
  });

  it("binds the manifest to sanitized memory corpus contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-corpus-"));
    temporaryDirectories.push(root);
    const scopePath = join(root, safePathSegment("scope-1"));
    await mkdir(scopePath, { recursive: true });
    const memoryPath = join(scopePath, "memory.jsonl");
    await writeFile(memoryPath, '{"memoryId":"m1","content":"blue"}\n');
    const original = await benchmarkCorpusHash(root, [question()]);

    await writeFile(memoryPath, '{"memoryId":"m1","content":"green"}\n');
    expect(await benchmarkCorpusHash(root, [question()])).not.toBe(original);
  });

  it("reports a git revision when available without hiding dirty state", () => {
    const revision = benchmarkSourceRevision();
    expect(revision.commit).toMatch(/^(?:[a-f0-9]{40}|unavailable)$/u);
    expect([true, false, null]).toContain(revision.dirty);
  });

  it("accepts an explicit build identity when Git is absent at runtime", () => {
    vi.stubEnv("PICORER_SOURCE_COMMIT", "a".repeat(40));
    vi.stubEnv("PICORER_SOURCE_DIRTY", "true");
    vi.stubEnv("PICORER_SOURCE_FINGERPRINT", "b".repeat(64));

    expect(benchmarkSourceRevision()).toEqual({
      commit: "a".repeat(40),
      dirty: true,
      fingerprint: "b".repeat(64),
    });
  });
});
