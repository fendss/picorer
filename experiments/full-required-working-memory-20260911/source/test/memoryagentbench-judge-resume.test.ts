import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  judgeArtifactIdentityMatches,
  judgeRowMatchesPrediction,
} from "../integrations/memoryagentbench/evaluate_longmemeval_official.mjs";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describe("MemoryAgentBench LongMemEval judge resume", () => {
  const expected = {
    mode: "static",
    model: "gpt-4o",
    sourcePath: "/artifacts/longmemeval-s-static.json",
    sourceArtifactSha256: "a".repeat(64),
  };

  const prior = {
    schema_version: 1,
    benchmark: "MemoryAgentBench",
    dataset: "longmemeval_s*",
    mode: expected.mode,
    judge_model: expected.model,
    official_prompt_source_commit:
      "fe1735de8cf8b9908e1e3d3b5612afc815698062",
    prompt_sha256:
      "2c90b57efc5142071e32e10b3b131bbad6ee37626b6287d007ab1f52a2cdf54d",
    source_artifact: expected.sourcePath,
    source_artifact_sha256: expected.sourceArtifactSha256,
    data: [{ benchmark_query_id: "q-1" }],
  };

  it("rejects labels from a different source artifact", () => {
    expect(judgeArtifactIdentityMatches(prior, expected)).toBe(true);
    expect(judgeArtifactIdentityMatches(prior, {
      ...expected,
      sourceArtifactSha256: "b".repeat(64),
    })).toBe(false);
  });

  it("rejects a cached label when its prediction or filled prompt changes", () => {
    const prompt = "filled official prompt";
    const source = { output: "Paris" };
    const priorRow = {
      source_prediction: source.output,
      source_prediction_sha256: sha256(source.output),
      judge_prompt_sha256: sha256(prompt),
    };

    expect(judgeRowMatchesPrediction(priorRow, source, prompt)).toBe(true);
    expect(judgeRowMatchesPrediction(priorRow, { output: "Lyon" }, prompt))
      .toBe(false);
    expect(judgeRowMatchesPrediction(priorRow, source, `${prompt}!`)).toBe(false);
  });
});
