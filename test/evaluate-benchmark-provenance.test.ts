import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceBenchmarkDataPaths,
  type EvidenceBenchmarkPrediction,
} from "../src/benchmark/index.js";
import type {
  AmaBenchPrivateLabel,
  AmaBenchPrivateQuery,
} from "../src/benchmark/amabench/index.js";
import { evaluateBenchmark } from "../src/entrypoints/cli/commands/evaluate-benchmark.js";
import { benchmarkQuerySetHash } from "../src/entrypoints/cli/evidence-benchmark-runtime.js";
import { parseCommand } from "../src/entrypoints/cli/parse-command.js";
import { mergeQuestionRecords } from "../src/entrypoints/cli/private-records.js";
import { safePathSegment } from "../src/util.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "picorer-evaluate-provenance-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

const DATASET_IDENTITY = {
  benchmark: "ama-bench",
  split: "focused",
  track: "official-open-ended",
  source: { revision: "fixture-v1" },
} as const;

const QUERY: AmaBenchPrivateQuery = {
  scopeId: "scope-1",
  episodeId: 1,
  questionId: "case-1",
  questionIndex: 0,
  question: "Record the selected color.",
};

const LABEL: AmaBenchPrivateLabel = {
  scopeId: QUERY.scopeId,
  episodeId: QUERY.episodeId,
  questionId: QUERY.questionId,
  questionIndex: QUERY.questionIndex,
  referenceAnswer: "blue",
  capability: "B",
  taskDescription: "Select the color recorded in memory.",
  taskType: "webarena",
  domain: "WEB",
};

const RETRIEVAL_IDENTITY = {
  providerId: "retrieval-provider",
  modelId: "retrieval-model",
  thinkingLevel: "off",
  transport: "non-stream",
  api: "openai-completions",
} as const;

const ANSWER_IDENTITY = {
  providerId: "answer-provider",
  modelId: "answer-model",
  thinkingLevel: "off",
  transport: "non-stream",
  api: "openai-completions",
} as const;

function prediction(): EvidenceBenchmarkPrediction {
  return {
    schema_version: 1,
    benchmark: "ama-bench",
    case_id: QUERY.questionId,
    scope_id: QUERY.scopeId,
    response: { kind: "text", text: "blue" },
    abstention: false,
    retrieval_status: "sufficient",
    citations: [],
    retrieval_model: {
      providerId: RETRIEVAL_IDENTITY.providerId,
      modelId: RETRIEVAL_IDENTITY.modelId,
      responseModels: [RETRIEVAL_IDENTITY.modelId],
      thinkingLevel: RETRIEVAL_IDENTITY.thinkingLevel,
      transport: RETRIEVAL_IDENTITY.transport,
    },
    answer_model: {
      providerId: ANSWER_IDENTITY.providerId,
      modelId: ANSWER_IDENTITY.modelId,
      responseModels: [ANSWER_IDENTITY.modelId],
      thinkingLevel: ANSWER_IDENTITY.thinkingLevel,
      transport: ANSWER_IDENTITY.transport,
      responseModel: ANSWER_IDENTITY.modelId,
    },
    answer_prompt: {
      adapter: "ama-bench-v4-openend",
      version: "fixture-answer-v1",
      hash: "a".repeat(64),
    },
    run_id: "run-1",
  };
}

function evaluationCommand(options: {
  dataDirectory: string;
  predictionsPath: string;
  output: string;
}) {
  return parseCommand([
    "evaluate-benchmark",
    "--benchmark", "ama-bench",
    "--data-dir", options.dataDirectory,
    "--predictions", options.predictionsPath,
    "--output", options.output,
  ]);
}

type Mismatch = "source-record" | "source-model" | "source-dataset";

async function provenanceFixture(
  root: string,
  mismatch: Mismatch,
): Promise<{
  dataDirectory: string;
  predictionsPath: string;
  output: string;
}> {
  const dataDirectory = join(root, "data");
  const runDirectory = join(root, "run");
  const predictionsPath = join(runDirectory, "predictions.jsonl");
  const output = join(root, "evaluation.json");
  const paths = evidenceBenchmarkDataPaths(dataDirectory);
  const frozenPrediction = prediction();
  const sourcePrediction = structuredClone(frozenPrediction);
  if (mismatch === "source-record") {
    sourcePrediction.response.text = "red";
  }

  const sourceDataset = mismatch === "source-dataset"
    ? {
        ...DATASET_IDENTITY,
        source: { revision: "different-fixture-revision" },
      }
    : DATASET_IDENTITY;
  const sourceAnswerModel = mismatch === "source-model"
    ? { ...ANSWER_IDENTITY, modelId: "different-answer-model" }
    : ANSWER_IDENTITY;

  await Promise.all([
    mergeQuestionRecords(paths.privateQueries, [QUERY]),
    mergeQuestionRecords(paths.privateLabels, [LABEL]),
    writeJson(paths.datasetManifest, {
      schema_version: 1,
      identity: DATASET_IDENTITY,
      retrieval: { retrievalProfile: "fts5" },
      case_count: 1,
    }),
    writeJsonLine(predictionsPath, frozenPrediction),
    writeJson(join(runDirectory, "run-manifest.json"), {
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      config: {
        benchmark: "ama-bench",
        dataset: sourceDataset,
        query_set_hash: benchmarkQuerySetHash([QUERY]),
        retrieval_model: RETRIEVAL_IDENTITY,
        answer_model: sourceAnswerModel,
      },
    }),
    writeJson(
      join(
        runDirectory,
        "records",
        `${safePathSegment(QUERY.questionId)}.json`,
      ),
      {
        schema_version: 1,
        benchmark: "ama-bench",
        case_id: QUERY.questionId,
        slot: 1,
        prediction: sourcePrediction,
      },
    ),
  ]);
  return { dataDirectory, predictionsPath, output };
}

describe("evaluate-benchmark checkpoint and provenance guards", () => {
  it.each(["output", "judge-records"] as const)(
    "rejects orphaned %s without an evaluation manifest",
    async (artifact) => {
      const root = await temporaryDirectory();
      const dataDirectory = join(root, "data");
      const runDirectory = join(root, "run");
      const predictionsPath = join(runDirectory, "predictions.jsonl");
      const output = join(root, "evaluation.json");
      await writeJsonLine(predictionsPath, prediction());
      if (artifact === "output") {
        await writeJson(output, { stale: true });
      } else {
        await writeJson(
          join(
            `${output}.judge-records`,
            `${safePathSegment(QUERY.questionId)}.json`,
          ),
          { questionId: QUERY.questionId, score: 1 },
        );
      }

      await expect(evaluateBenchmark(evaluationCommand({
        dataDirectory,
        predictionsPath,
        output,
      }))).rejects.toThrow(/artifacts exist without their manifest/u);
      await expect(readFile(`${output}.manifest.json`, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    ["source-record", /not bound to its source record/u],
    ["source-model", /Prediction answer model mismatch/u],
    ["source-dataset", /do not match their source run manifest/u],
  ] as const)(
    "rejects a %s provenance mismatch",
    async (mismatch, expectedError) => {
      const root = await temporaryDirectory();
      const fixture = await provenanceFixture(root, mismatch);

      await expect(evaluateBenchmark(evaluationCommand(fixture)))
        .rejects.toThrow(expectedError);
      await expect(readFile(`${fixture.output}.manifest.json`, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(fixture.output, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
