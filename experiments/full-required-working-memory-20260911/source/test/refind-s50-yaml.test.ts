import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  environmentForS50,
  loadS50Yaml,
  validateS50Inputs,
} from "../integrations/refind-longmemeval/run_s50_from_yaml.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function configFile(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-refind-yaml-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "run.yaml");
  await writeFile(path, `
schema_version: 1
paths:
  root: ./experiment
  output_dir: ./output
  evaluator_source: ./source.json
source:
  commit: 9f87a1c
  fingerprint: test-fingerprint
credentials:
  generation:
    api_key: test-generation-key
    base_url: https://generation.example/v1/
  judge:
    api_key: test-judge-key
    base_url: https://judge.example/v1
models:
  retrieval:
    id: gpt-5-mini
  answer:
    id: gpt-5-mini
  judge:
    id: gpt-4.1-mini
run:
  label: unit-test
  slots: 128
  max_search_calls: 8
`, "utf8");
  await chmod(path, mode);
  await writeFile(
    join(directory, "source.json"),
    JSON.stringify([{ sample_id: "sample", qa: [{ question_id: "q" }] }]),
    "utf8",
  );
  return path;
}

describe("ReFind S50 YAML configuration", () => {
  it("loads one protected config and maps it to the existing runner", async () => {
    const path = await configFile();
    const config = loadS50Yaml(path);
    const environment = environmentForS50(config, { KEEP: "yes" });

    expect(config.credentials.generation.apiKey).toBe("test-generation-key");
    expect(config.credentials.judge.apiKey).toBe("test-judge-key");
    expect(config.models.retrieval).toMatchObject({
      id: "gpt-5-mini",
      thinkingLevel: "medium",
      contextWindow: 128_000,
      maxTokens: 4_096,
    });
    expect(environment).toMatchObject({
      KEEP: "yes",
      OPENAI_API_KEY: "test-generation-key",
      OPENAI_API_BASE: "https://generation.example/v1",
      REFIND_JUDGE_API_KEY: "test-judge-key",
      REFIND_JUDGE_API_BASE: "https://judge.example/v1",
      REFIND_SLOTS: "128",
      REFIND_MAX_SEARCH_CALLS: "8",
    });
    expect(config.run.maxSearchCalls).toBe(8);
    expect(() => validateS50Inputs(config)).not.toThrow();
  });

  it("rejects a config readable by other users", async () => {
    const path = await configFile(0o644);
    expect(() => loadS50Yaml(path)).toThrow(/mode 0600/iu);
  });
});
