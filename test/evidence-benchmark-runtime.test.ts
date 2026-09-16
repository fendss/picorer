import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import {
  BENCHMARK_MODEL_FLAGS,
  benchmarkModelOptionsFor,
  benchmarkQuerySetHash,
  benchmarkRuntimeIdentity,
  benchmarkSystemicRuntimeFailure,
  ensureBenchmarkRunManifest,
  migrateBenchmarkRunInfrastructure,
} from "../src/entrypoints/cli/evidence-benchmark-runtime.js";
import { parseCommand } from "../src/entrypoints/cli/parse-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "evidence-benchmark-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

describe("evidence benchmark runtime", () => {
  it("halts only for explicit provider-wide status failures", () => {
    expect(benchmarkSystemicRuntimeFailure("429 status code (no body)")).toBe(true);
    expect(benchmarkSystemicRuntimeFailure("HTTP 429: too many requests")).toBe(true);
    expect(benchmarkSystemicRuntimeFailure("status code: 403")).toBe(true);
    expect(benchmarkSystemicRuntimeFailure("rate limited by provider")).toBe(true);
    expect(benchmarkSystemicRuntimeFailure("JSON parse error at position 429")).toBe(false);
    expect(benchmarkSystemicRuntimeFailure("case UUID ends in 429")).toBe(false);
  });

  it("exports all role flags and resolves judge overrides field by field", () => {
    vi.stubEnv("COMMON_KEY", "common-secret");
    vi.stubEnv("COMMON_BASE", "https://common.example/v1");
    const parsed = parseCommand([
      "benchmark-example",
      "--agent-dir", "/common-agent",
      "--provider", "common-provider",
      "--model", "common-model",
      "--model-adapter", "qwen-completions",
      "--context-window", "32768",
      "--max-tokens", "8192",
      "--thinking-level", "medium",
      "--api-key-env", "COMMON_KEY",
      "--base-url-env", "COMMON_BASE",
      "--transport", "non-stream",
      "--judge-model", "judge-model",
      "--judge-thinking-level", "off",
      "--judge-transport", "sse",
    ]);

    expect(BENCHMARK_MODEL_FLAGS).toEqual(expect.arrayContaining([
      "retrieval-model",
      "retrieval-model-adapter",
      "retrieval-context-window",
      "retrieval-max-tokens",
      "answer-model",
      "judge-model",
      "judge-api-key-env",
      "judge-base-url-env",
      "judge-transport",
    ]));
    expect(benchmarkModelOptionsFor(parsed, "judge")).toEqual({
      agentDir: "/common-agent",
      providerId: "common-provider",
      modelId: "judge-model",
      modelAdapterId: "qwen-completions",
      contextWindow: 32768,
      maxTokens: 8192,
      thinkingLevel: "off",
      apiKeyEnv: "COMMON_KEY",
      baseUrl: "https://common.example/v1",
      transport: "sse",
    });
  });

  it("records only the stable model runtime identity", () => {
    const runtime = {
      modelAdapterId: "test-adapter",
      providerId: "provider-a",
      modelId: "model-a",
      thinkingLevel: "high",
      transport: "non-stream",
      model: {
        api: "openai-responses",
        baseUrl: "https://models.example/v1",
      },
      requestPolicy: {
        timeoutMs: 1_800_000,
        maxRetries: 3,
        maxRetryDelayMs: 60_000,
      },
      streamFn: () => {
        throw new Error("not used");
      },
      getApiKey: async () => "secret",
    } as unknown as PiModelRuntime;

    expect(benchmarkRuntimeIdentity(runtime)).toEqual({
      modelAdapterId: "test-adapter",
      providerId: "provider-a",
      modelId: "model-a",
      thinkingLevel: "high",
      transport: "non-stream",
      api: "openai-responses",
      baseUrl: "https://models.example/v1",
      requestPolicy: {
        timeoutMs: 1_800_000,
        maxRetries: 3,
        maxRetryDelayMs: 60_000,
      },
    });
  });

  it("hashes complete query records canonically as a set", () => {
    const original = benchmarkQuerySetHash([
      {
        questionId: "q-2",
        scopeId: "scope-2",
        question: "Second?",
      },
      {
        questionId: "q-1",
        scopeId: "scope-1",
        question: "First?",
        tool: { name: "lookup", parameters: { z: 2, a: 1 } },
      },
    ]);
    expect(benchmarkQuerySetHash([
      {
        tool: { parameters: { a: 1, z: 2 }, name: "lookup" },
        question: "First?",
        scopeId: "scope-1",
        questionId: "q-1",
      },
      {
        question: "Second?",
        questionId: "q-2",
        scopeId: "scope-2",
      },
    ])).toBe(original);
    expect(benchmarkQuerySetHash([
      {
        questionId: "q-1",
        scopeId: "scope-1",
        question: "First?",
        tool: { name: "lookup", parameters: { z: 3, a: 1 } },
      },
      {
        questionId: "q-2",
        scopeId: "scope-2",
        question: "Second?",
      },
    ])).not.toBe(original);
  });

  it("resumes an identical manifest and rejects a changed configuration", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "run-manifest.json");
    const created = await ensureBenchmarkRunManifest(path, {
      benchmark: "example",
      models: { retrieval: "r", answer: "a" },
    });
    const resumed = await ensureBenchmarkRunManifest(path, {
      models: { answer: "a", retrieval: "r" },
      benchmark: "example",
    });

    expect(resumed.created_at).toBe(created.created_at);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(created);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(ensureBenchmarkRunManifest(path, {
      benchmark: "example",
      models: { retrieval: "different", answer: "a" },
    })).rejects.toThrow(/different run configuration/u);
  });

  it("audits an explicit infrastructure-only resume without changing semantics", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "run-manifest.json");
    const created = await ensureBenchmarkRunManifest(path, {
      benchmark: "ama-bench",
      model: { id: "qwen3-32b", thinking: "high" },
      source_revision: { commit: "a".repeat(40), dirty: false },
      slots: 8,
    });

    const migrated = await migrateBenchmarkRunInfrastructure(path, {
      benchmark: "ama-bench",
      model: { id: "qwen3-32b", thinking: "high" },
      source_revision: {
        commit: "a".repeat(40),
        dirty: true,
        fingerprint: "b".repeat(64),
      },
      slots: 64,
    }, ["slots", "source_revision"]);

    expect(migrated.created_at).toBe(created.created_at);
    expect(migrated.config.slots).toBe(64);
    const auditFiles = await readdir(join(root, "execution-migrations"));
    expect(auditFiles).toHaveLength(1);
    const auditPath = join(root, "execution-migrations", auditFiles[0]!);
    const audit = JSON.parse(await readFile(auditPath, "utf8")) as {
      allowed_config_changes: string[];
      changes: Record<string, { before: unknown; after: unknown }>;
    };
    expect(audit.allowed_config_changes).toEqual(["slots", "source_revision"]);
    expect(audit.changes.slots).toEqual({ before: 8, after: 64 });
    expect(audit.changes.source_revision).toBeDefined();
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);

    await expect(migrateBenchmarkRunInfrastructure(path, {
      ...migrated.config,
      model: { id: "different", thinking: "high" },
      slots: 128,
    }, ["slots", "source_revision"])).rejects.toThrow(
      /would change the experiment configuration/u,
    );
  });

  it("rejects source revision changes when only concurrency may migrate", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "run-manifest.json");
    await ensureBenchmarkRunManifest(path, {
      benchmark: "ama-bench",
      source_revision: { commit: "a".repeat(40), dirty: false },
      slots: 8,
    });

    await expect(migrateBenchmarkRunInfrastructure(path, {
      benchmark: "ama-bench",
      source_revision: { commit: "b".repeat(40), dirty: false },
      slots: 64,
    }, ["slots"])).rejects.toThrow(
      /would change the experiment configuration/u,
    );
  });

  it("allows only one configuration to create a new manifest concurrently", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "run-manifest.json");
    const results = await Promise.allSettled([
      ensureBenchmarkRunManifest(path, { benchmark: "first" }),
      ensureBenchmarkRunManifest(path, { benchmark: "second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      config: { benchmark: string };
    };
    expect(["first", "second"]).toContain(stored.config.benchmark);
  });
});
