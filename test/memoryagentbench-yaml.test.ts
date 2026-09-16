import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORYARENA_ANSWER_PROMPT_VERSION } from
  "../src/benchmark/memoryarena-public/index.js";
import {
  loadMemoryAgentBenchYaml,
  artifactStatus,
  runConfigIdentity,
  runnerInvocation,
  runtimeIdentityForConfig,
  serviceEnvironment,
} from "../integrations/memoryagentbench/run_from_yaml.mjs";
import { OpenAICompatibleEmbedder } from
  "../src/retrieval/adapters/openai/openai-compatible-embedder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function configFile(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-mab-yaml-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "run.yaml");
  await mkdir(
    join(directory, "source", ".agents", "skills", "picorer-retrieval-minimal"),
    { recursive: true },
  );
  await writeFile(
    join(
      directory,
      "source",
      ".agents",
      "skills",
      "picorer-retrieval-minimal",
      "SKILL.md",
    ),
    "test skill\n",
  );
  await writeFile(join(directory, "embedding.env"), "PICORER_EMBEDDING_MODEL=test\n");
  await writeFile(join(directory, "generation-ca.pem"), "test generation CA\n");
  await writeFile(path, `
schema_version: 1
paths:
  root: ./root
  source: ./source
  data_dir: ./data
  output_dir: ./output
  runtime_dir: ./runtime
  nltk_data: ./nltk
  embedding_env: ./embedding.env
  node: /tools/node
  uv: /tools/uv
credentials:
  generation:
    api_key: test-key
    base_url: https://generation.example/v1/
    ca_bundle: ./generation-ca.pem
models:
  retrieval:
    id: gpt-5-mini
    route_id: gpt-5-mini-medium
    protocol: openai-reasoning-completions
    thinking_level: medium
    context_window: 128000
    max_tokens: 4096
  answer:
    id: gpt-4.1-mini
    protocol: openai-completions
    context_safety_tokens: 24576
service:
  host: 127.0.0.1
  port: 3113
  source_identity: source-test-v1
  build_identity: build-test-v1
  skill: picorer-minimal
  interface_mode: compact
  max_run_ms: 240000
  max_turns: 64
  max_tool_calls: 80
  request_timeout_ms: 150000
run:
  task: trec-fine
  label: smoke
  modes: [static, cumulative]
  max_search_calls: 4
  reuse_ingestion_from:
    trec-fine: ./baseline/trec-fine-static.json
  max_contexts: 1
  max_queries: 1
  slots: 1
  context_slots: 5
  query_slots: 16
  answer_timeout_seconds: 600
  memory_timeout_seconds: 1260
  adaptive_query_slots:
    minimum: 1
    initial: 4
    successes_per_increase: 8
`, "utf8");
  await chmod(path, mode);
  return path;
}

describe("MemoryAgentBench YAML configuration", () => {
  it("drives both model identities and runner arguments from one protected file", async () => {
    const path = await configFile();
    const config = loadMemoryAgentBenchYaml(path);
    const invocation = runnerInvocation(config, "static");

    expect(config.credentials.generation.apiKey).toBe("test-key");
    expect(config.models.retrieval).toMatchObject({
      id: "gpt-5-mini",
      routeId: "gpt-5-mini-medium",
      thinkingLevel: "medium",
    });
    expect(invocation.command).toBe("/tools/uv");
    expect(invocation.args).toContain("gpt-4.1-mini");
    expect(invocation.args.slice(
      invocation.args.indexOf("--answer-context-safety-tokens"),
      invocation.args.indexOf("--answer-context-safety-tokens") + 2,
    )).toEqual(["--answer-context-safety-tokens", "24576"]);
    expect(invocation.args).toContain("http://127.0.0.1:3113");
    expect(invocation.env.OPENAI_API_KEY).toBe("test-key");
    expect(invocation.env.SSL_CERT_FILE).toContain("generation-ca.pem");
    expect(invocation.env.REQUESTS_CA_BUNDLE).toContain("generation-ca.pem");
    expect(config.run.contextSlots).toBe(5);
    expect(config.run.querySlots).toBe(16);
    expect(config.run.adaptiveQuerySlots).toEqual({
      minimum: 1,
      initial: 4,
      maximum: 16,
      successesPerIncrease: 8,
    });
    expect(config.service.maxConcurrentWraps).toBe(16);
    expect(config.service.skill).toBe("picorer-minimal");
    expect(config.service.interfaceMode).toBe("compact");
    expect(serviceEnvironment(config, {}).PICORER_MAX_CONCURRENT_WRAPS).toBe("16");
    expect(serviceEnvironment(config, {}).PICORER_REQUEST_TIMEOUT_MS).toBe("150000");
    expect(serviceEnvironment(config, {}).PICORER_SKILL).toBe("picorer-minimal");
    expect(serviceEnvironment(config, {}).PICORER_INTERFACE_MODE).toBe("compact");
    expect(serviceEnvironment(config, {}).NODE_EXTRA_CA_CERTS).toContain(
      "generation-ca.pem",
    );
    const identityBeforeCaChange = runConfigIdentity(config, "trec-fine", "static");
    await writeFile(
      join(path, "..", "generation-ca.pem"),
      "changed test generation CA\n",
    );
    const changedCaConfig = loadMemoryAgentBenchYaml(config.configPath);
    expect(runConfigIdentity(changedCaConfig, "trec-fine", "static")).not.toBe(
      identityBeforeCaChange,
    );
    expect(runtimeIdentityForConfig(config).contract.agent_interface).toBe("compact");
    expect(runtimeIdentityForConfig(config).contract).toMatchObject({
      limits: { request_timeout_ms: 150000 },
    });
    expect(invocation.args).toContain("--context-slots");
    expect(invocation.args.slice(
      invocation.args.indexOf("--answer-timeout-seconds"),
      invocation.args.indexOf("--answer-timeout-seconds") + 2,
    )).toEqual(["--answer-timeout-seconds", "600"]);
    expect(invocation.args.slice(
      invocation.args.indexOf("--memory-timeout-seconds"),
      invocation.args.indexOf("--memory-timeout-seconds") + 2,
    )).toEqual(["--memory-timeout-seconds", "1260"]);
    expect(invocation.args).toContain("5");
    expect(invocation.args).toContain("--adaptive-query-slots");
    expect(invocation.args).toContain("--adaptive-query-slots-initial");
    expect(invocation.args).toContain("4");
    expect(config.service.sourceIdentity).toBe("source-test-v1");
    expect(serviceEnvironment(config, {}).PICORER_BUILD_IDENTITY).toBe(
      "build-test-v1",
    );
    expect(invocation.args).toContain("--run-config-sha256");
    expect(
      runtimeIdentityForConfig(config).contract.answer_handoff,
    ).toMatchObject({ prompt_version: MEMORYARENA_ANSWER_PROMPT_VERSION });
    expect(config.run.reuseIngestionFrom["trec-fine"]).toContain(
      "/baseline/trec-fine-static.json",
    );
    expect(invocation.args).toContain("--reuse-ingestion-from");
  });

  it("rejects a config readable by other users", async () => {
    const path = await configFile(0o644);
    expect(() => loadMemoryAgentBenchYaml(path)).toThrow(
      /mode 0600/iu,
    );
  });

  it("rejects a configured generation CA bundle that is missing", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    const current = await source.readFile(path, "utf8");
    await source.writeFile(
      path,
      current.replace("./generation-ca.pem", "./missing-generation-ca.pem"),
    );
    await chmod(path, 0o600);
    expect(() => loadMemoryAgentBenchYaml(path)).toThrow(
      /ca_bundle must identify an existing file/iu,
    );
  });

  it("pins the Qdrant index in the service runtime identity", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    await source.writeFile(
      join(path, "..", "embedding.env"),
      [
        "PICORER_EMBEDDING_BASE_URL=https://embedding.example/v1",
        "PICORER_EMBEDDING_API_KEY=test-embedding-key",
        "PICORER_EMBEDDING_MODEL=text-embedding-v4",
        "PICORER_EMBEDDING_DIMENSIONS=1024",
        "PICORER_EMBEDDING_MAX_INPUT_LENGTH=2048",
        "",
      ].join("\n"),
    );
    const current = await source.readFile(path, "utf8");
    await source.writeFile(
      path,
      current.replace(
        "  build_identity: build-test-v1",
        [
          "  build_identity: build-test-v1",
          "  retrieval_profile: picorer-hybrid-qdrant-hnsw-v1",
          "  qdrant:",
          "    url: http://127.0.0.1:6333/",
          "    collection: test_vectors",
          "    vector_generation_id: test-generation-v1",
          "    request_timeout_ms: 90000",
          "    hnsw_ef: 640",
        ].join("\n"),
      ),
    );
    await chmod(path, 0o600);

    const config = loadMemoryAgentBenchYaml(path);
    const environment = serviceEnvironment(config, {
      PICORER_QDRANT_API_KEY: "stale-ambient-key",
    });
    const embedder = OpenAICompatibleEmbedder.fromEnvironment(environment);
    const identity = runtimeIdentityForConfig(config);

    expect(environment).toMatchObject({
      PICORER_RETRIEVAL_PROFILE: "picorer-hybrid-qdrant-hnsw-v1",
      PICORER_QDRANT_URL: "http://127.0.0.1:6333",
      PICORER_QDRANT_COLLECTION: "test_vectors",
      PICORER_VECTOR_GENERATION_ID: "test-generation-v1",
      PICORER_QDRANT_TIMEOUT_MS: "90000",
      PICORER_QDRANT_HNSW_EF: "640",
      PICORER_EXPECTED_RUNTIME_IDENTITY_SHA256: identity.sha256,
    });
    expect(environment.PICORER_QDRANT_API_KEY).toBeUndefined();
    expect(identity.contract.memory_index).toEqual({
      retrievalProfile: "picorer-hybrid-qdrant-hnsw-v1",
      embeddingProfileId: embedder.profileId,
      embeddingModel: embedder.model,
      embeddingDimensions: embedder.dimensions,
      vectorGenerationId: "test-generation-v1",
      vectorCollection: "test_vectors",
      vectorSearch: {
        algorithm: "qdrant-hnsw",
        hnswM: 32,
        efConstruct: 200,
        hnswEf: 640,
        fullScanThresholdKb: 1_000,
        indexingThresholdKb: 10_000,
        exact: false,
        requestTimeoutMs: 90_000,
        fallbackPolicy: "sqlite-exact-on-unavailable-v1",
      },
    });
    const changed = structuredClone(config);
    changed.service.qdrant!.hnswEf += 1;
    expect(runtimeIdentityForConfig(changed).sha256).not.toBe(identity.sha256);
  });

  it("rejects adaptive concurrency outside the query-slot ceiling", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    const current = await source.readFile(path, "utf8");
    await source.writeFile(path, current.replace("    initial: 4", "    initial: 32"));
    await chmod(path, 0o600);

    expect(() => loadMemoryAgentBenchYaml(path)).toThrow(
      /adaptive_query_slots\.initial/iu,
    );
  });

  it("rejects multiple suite workers with independent adaptive controllers", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    const current = await source.readFile(path, "utf8");
    await source.writeFile(path, current.replace("  slots: 1", "  slots: 2"));
    await chmod(path, 0o600);

    expect(() => loadMemoryAgentBenchYaml(path)).toThrow(
      /slots must be 1/iu,
    );
  });

  it("supports a full task suite without smoke limits", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    const current = await source.readFile(path, "utf8");
    await source.writeFile(
      path,
      current
        .replace("task: trec-fine", "tasks: [trec-fine, banking77]")
        .replace("  max_contexts: 1\n  max_queries: 1\n", ""),
    );
    await chmod(path, 0o600);
    const config = loadMemoryAgentBenchYaml(path);
    const invocation = runnerInvocation(config, "cumulative", undefined, "banking77", true);

    expect(config.run.tasks).toEqual(["trec-fine", "banking77"]);
    expect(config.run.maxContexts).toBeNull();
    expect(invocation.args).not.toContain("--max-contexts");
    expect(invocation.args).not.toContain("--max-queries");
    expect(invocation.args).toContain("--resume");
    expect(invocation.output).toMatch(/banking77-cumulative\.json$/u);
  });

  it("rejects configured retries for method failures", async () => {
    const path = await configFile();
    const source = await import("node:fs/promises");
    const current = await source.readFile(path, "utf8");
    await source.writeFile(
      path,
      current.replace(
        "  max_search_calls: 4",
        "  max_search_calls: 4\n  retry_error_codes: [retrieval_agent_timeout]",
      ),
    );
    await chmod(path, 0o600);

    expect(() => loadMemoryAgentBenchYaml(path)).toThrow(
      /method failures are final/iu,
    );
  });

  it("does not accept a completed counter without exact query rows", async () => {
    const config = loadMemoryAgentBenchYaml(await configFile());
    const output = join(
      config.paths.outputDir,
      config.run.label,
      "trec-fine-static.json",
    );
    await mkdir(join(config.paths.outputDir, config.run.label), {
      recursive: true,
    });
    const runtimeIdentity = runtimeIdentityForConfig(config);
    const artifact = {
      task: "trec-fine",
      operator_experiment: { mode: "static" },
      answer_model: config.models.answer.id,
      memory_base_url: "http://127.0.0.1:3113",
      run_config_sha256: runConfigIdentity(config, "trec-fine", "static"),
      retrieval_runtime_contract: runtimeIdentity.contract,
      retrieval_runtime_identity_sha256: runtimeIdentity.sha256,
      memory_persistence_identity: "store-1",
      expected_query_ids: ["context-0/q-1"],
      completed_queries: 1,
      data: [],
    };
    await writeFile(output, `${JSON.stringify(artifact)}\n`);

    expect(artifactStatus(config, "trec-fine", "static")).toMatchObject({
      status: "invalid",
    });

    await writeFile(output, `${JSON.stringify({
      ...artifact,
      data: [{ benchmark_query_id: "context-0/q-1" }],
    })}\n`);
    expect(artifactStatus(config, "trec-fine", "static")).toMatchObject({
      status: "completed",
      completed_queries: 1,
    });
  });
});
