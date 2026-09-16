import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMA_BENCH_ANSWER_PROMPT_TEMPLATE,
  AMA_BENCH_ANSWER_PROMPT_VERSION,
  AMA_BENCH_V4_IDENTITY,
  adaptAmaBenchV4,
  amaBenchMemoryId,
  amaBenchScopeId,
  amaBenchSessionId,
  buildAmaBenchAnswerPrompt,
  buildAmaBenchEpisodeSubmissions,
  buildAmaBenchEvaluatorInput,
  loadPinnedAmaBenchV4File,
  parseAmaBenchV4Jsonl,
  renderAmaBenchStep,
  type AmaBenchPrivateLabel,
  type AmaBenchPrivateQuery,
  type AmaBenchQuestionPrediction,
} from "../src/benchmark/amabench/index.js";
import type { PicorerResult } from "../src/evidence-agent/index.js";
import { ingestMemorySessions } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import { sha256 } from "../src/util.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function fixture(): unknown[] {
  return [{
    episode_id: 7,
    task: "Inspect the page and recover the final state.",
    task_type: "webarena",
    domain: "WEB",
    success: true,
    num_turns: 2,
    total_tokens: 91,
    trajectory: [
      {
        turn_idx: 0,
        action: "click('submit')",
        observation: "The status changed from pending to complete.",
        answer: "STEP_GOLD_MUST_NOT_ESCAPE",
        capability: "STEP_CAPABILITY_MUST_NOT_ESCAPE",
      },
      {
        turn_idx: 1,
        action: null,
        observation: null,
      },
    ],
    qa_pairs: [{
      question: "PRIVATE_QUESTION_TEXT",
      answer: "GOLD_ANSWER_MUST_NOT_ESCAPE",
      type: "C",
      question_uuid: "11111111-1111-4111-8111-111111111111",
      evidence: "QA_EVIDENCE_MUST_NOT_ESCAPE",
    }],
    hidden_label: "ROOT_LABEL_MUST_NOT_ESCAPE",
  }];
}

function identities(): {
  query: AmaBenchPrivateQuery;
  label: AmaBenchPrivateLabel;
  prediction: AmaBenchQuestionPrediction;
} {
  const adapted = adaptAmaBenchV4(fixture());
  const query = adapted.privateQueries[0];
  const label = adapted.privateLabels[0];
  if (query === undefined || label === undefined) {
    throw new Error("fixture adaptation failed");
  }
  return {
    query,
    label,
    prediction: {
      scopeId: query.scopeId,
      episodeId: query.episodeId,
      questionId: query.questionId,
      questionIndex: query.questionIndex,
      answer: "The status became complete.",
      reasoningTrace: "Selected the state update at Step 0.",
    },
  };
}

describe("AMA-Bench v4 trusted adapter", () => {
  it("pins independent code and dataset identities", () => {
    expect(AMA_BENCH_V4_IDENTITY).toEqual({
      datasetId: "AMA-bench/AMA-bench",
      datasetRevision: "a5777378066f53229a94557a7b192435cd027909",
      relativePath: "test/open_end_qa_set.jsonl",
      sha256: "45c36052e1520d87ad9de4114f71c9df42d4aac9cf158c0c353e800b653d65ff",
      upstreamCodeRevision: "ddfd319e0be33424288c13806f1eafc63e625b59",
      paperRevision: "arXiv:2602.22769v4",
      episodeCount: 208,
      questionCount: 2_496,
    });
  });

  it("maps task plus action-observation steps into one deterministic session", () => {
    const first = adaptAmaBenchV4(fixture());
    const second = adaptAmaBenchV4(fixture());

    expect(second).toEqual(first);
    expect(amaBenchScopeId(7)).toBe("ama-v4-6c9217f2c0028966");
    expect(amaBenchSessionId("ama-v4-6c9217f2c0028966")).toBe(
      "s-044355596adf952d",
    );
    expect(
      amaBenchMemoryId("ama-v4-6c9217f2c0028966", "step:0"),
    ).toBe("m-a150452fac23d6f60c8b61d9");

    expect(first.memorySessions).toHaveLength(1);
    expect(first.memorySessions[0]).toEqual({
      scopeId: "ama-v4-6c9217f2c0028966",
      sessionId: "s-044355596adf952d",
      turns: [
        {
          id: "m-908760ca2b8d592a7809cfb2",
          role: "system",
          content: "Task:\nInspect the page and recover the final state.",
          metadata: { sourceKind: "task" },
        },
        {
          id: "m-a150452fac23d6f60c8b61d9",
          role: "other",
          content: [
            "Step 0:",
            "Action: click('submit')",
            "Observation: The status changed from pending to complete.",
          ].join("\n"),
          metadata: {
            sourceKind: "trajectory-step",
            sourceTurnIndex: 0,
          },
        },
        {
          id: "m-3112393c7d848885d942c4a9",
          role: "other",
          content: "Step 1:\nAction: None\nObservation: None",
          metadata: {
            sourceKind: "trajectory-step",
            sourceTurnIndex: 1,
          },
        },
      ],
      metadata: {
        datasetId: "AMA-bench/AMA-bench",
        datasetRevision: "a5777378066f53229a94557a7b192435cd027909",
        sourceEpisodeId: 7,
      },
    });
  });

  it("mirrors upstream step formatting while preserving empty and null payloads", () => {
    expect(renderAmaBenchStep({
      turnIndex: 4,
      action: "",
      observation: "",
    })).toBe("Step 4:\nAction: \nObservation: ");
    expect(renderAmaBenchStep({
      turnIndex: 5,
      action: null,
      observation: null,
    })).toBe("Step 5:\nAction: None\nObservation: None");
  });

  it("admits only task and trajectory whitelist fields into memory", () => {
    const result = adaptAmaBenchV4(fixture());
    const serializedMemory = JSON.stringify(result.memorySessions);

    expect(serializedMemory).toContain("Inspect the page");
    expect(serializedMemory).toContain("click('submit')");
    expect(serializedMemory).toContain("pending to complete");
    expect(serializedMemory).not.toContain("PRIVATE_QUESTION_TEXT");
    expect(serializedMemory).not.toContain("GOLD_ANSWER_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("STEP_GOLD_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("QA_EVIDENCE_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("STEP_CAPABILITY_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("ROOT_LABEL_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("webarena");
    expect(serializedMemory).not.toContain("WEB");
    expect(serializedMemory).not.toContain("GOLD_ANSWER");
  });

  it("keeps query-visible data and judge-only labels in distinct DTOs", () => {
    const result = adaptAmaBenchV4(fixture());
    expect(result.privateQueries).toEqual([{
      scopeId: "ama-v4-6c9217f2c0028966",
      episodeId: 7,
      questionId: "11111111-1111-4111-8111-111111111111",
      questionIndex: 0,
      question: "PRIVATE_QUESTION_TEXT",
    }]);
    expect(Object.keys(result.privateQueries[0] ?? {}).sort()).toEqual([
      "episodeId",
      "question",
      "questionId",
      "questionIndex",
      "scopeId",
    ]);
    expect(JSON.stringify(result.privateQueries)).not.toContain("GOLD_ANSWER");
    expect(JSON.stringify(result.privateQueries)).not.toContain("capability");
    expect(result.privateLabels).toEqual([{
      scopeId: "ama-v4-6c9217f2c0028966",
      episodeId: 7,
      questionId: "11111111-1111-4111-8111-111111111111",
      questionIndex: 0,
      referenceAnswer: "GOLD_ANSWER_MUST_NOT_ESCAPE",
      capability: "C",
      taskDescription: "Inspect the page and recover the final state.",
      taskType: "webarena",
      domain: "WEB",
    }]);
  });

  it("crosses the ordinary Picorer ingest and search ports without translation", async () => {
    const result = adaptAmaBenchV4(fixture());
    const directory = await mkdtemp(join(tmpdir(), "picorer-ama-ingest-"));
    temporaryDirectories.push(directory);
    const store = await MemoryStore.create(join(directory, "memory.sqlite"));
    try {
      await expect(
        ingestMemorySessions(store, result.memorySessions),
      ).resolves.toEqual([{
        scopeId: "ama-v4-6c9217f2c0028966",
        status: "inserted",
        memoryCount: 3,
      }]);
      const hits = store.search("ama-v4-6c9217f2c0028966", {
        queries: ["status pending complete"],
        limit: 3,
      });
      expect(hits[0]?.record.content).toContain("pending to complete");
    } finally {
      store.close();
    }
  });

  it("fails closed on schema drift and duplicate source coordinates", () => {
    const badCount = fixture() as Array<Record<string, unknown>>;
    badCount[0]!["num_turns"] = 3;
    expect(() => adaptAmaBenchV4(badCount)).toThrow(/num_turns/u);

    const badCapability = fixture() as Array<{
      qa_pairs: Array<Record<string, unknown>>;
    }>;
    badCapability[0]!.qa_pairs[0]!["type"] = "E";
    expect(() => adaptAmaBenchV4(badCapability)).toThrow(/unsupported value/u);

    const duplicateStep = fixture() as Array<{
      trajectory: Array<Record<string, unknown>>;
    }>;
    duplicateStep[0]!.trajectory[1]!["turn_idx"] = 0;
    expect(() => adaptAmaBenchV4(duplicateStep)).toThrow(/Duplicate.*turn_idx/u);
  });

  it("parses JSONL strictly and rejects data without the pinned hash", async () => {
    const serialized = `${JSON.stringify(fixture()[0])}\n`;
    expect(parseAmaBenchV4Jsonl(serialized)).toEqual(fixture());
    expect(() => parseAmaBenchV4Jsonl(`${serialized}\n`)).toThrow(/must not be blank/u);

    const directory = await mkdtemp(join(tmpdir(), "picorer-ama-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "open_end_qa_set.jsonl");
    await writeFile(path, serialized, "utf8");
    await expect(loadPinnedAmaBenchV4File(path)).rejects.toThrow(
      /dataset hash mismatch/u,
    );
  });
});

describe("AMA-Bench answer and evaluation contracts", () => {
  it("builds answer context from every exact read source in trajectory order", () => {
    const { query } = identities();
    const retrieval = {
      scopeId: query.scopeId,
      question: query.question,
      citations: [
        { memoryId: "m-step-2", supports: "final state" },
        { memoryId: "m-step-1", supports: "prior state" },
        { memoryId: "m-read-third", supports: "later read state" },
      ],
      evidence: [
        {
          memoryId: "m-step-2",
          sessionId: "s-one",
          turnIndex: 2,
          content: "Step 2:\nAction: finish\nObservation: complete",
        },
        {
          memoryId: "m-step-1",
          sessionId: "s-one",
          turnIndex: 1,
          content: "Step 1:\nAction: submit\nObservation: processing",
        },
        {
          memoryId: "m-read-third",
          sessionId: "s-one",
          turnIndex: 3,
          content: "THIRD_READ_MEMORY_MUST_REACH_ANSWER",
        },
      ],
    } as unknown as PicorerResult;

    const prompt = buildAmaBenchAnswerPrompt({ query, retrieval });
    expect(prompt.adapterId).toBe("ama-bench-v4-openend");
    expect(prompt.promptVersion).toBe(AMA_BENCH_ANSWER_PROMPT_VERSION);
    expect(prompt.userPrompt).toContain("m-step-1");
    expect(prompt.userPrompt).toContain("m-step-2");
    expect(prompt.userPrompt.indexOf("m-step-1")).toBeLessThan(
      prompt.userPrompt.indexOf("m-step-2"),
    );
    expect(prompt.userPrompt).toContain("THIRD_READ_MEMORY_MUST_REACH_ANSWER");
    expect(prompt.userPrompt).toContain("Question: PRIVATE_QUESTION_TEXT");
  });

  it("rejects citations that are not present in Evidence", () => {
    const { query } = identities();
    const retrieval = {
      scopeId: query.scopeId,
      question: query.question,
      citations: [{ memoryId: "m-not-evidence", supports: "unsupported" }],
      evidence: [],
    } as unknown as PicorerResult;
    expect(() => buildAmaBenchAnswerPrompt({ query, retrieval })).toThrow(
      /exact read package and citations do not match/u,
    );
  });

  it("pins the answer prompt and joins labels only at evaluator time", () => {
    expect(AMA_BENCH_ANSWER_PROMPT_VERSION).toBe(
      "ama-bench-v4-openend-read-trajectory-v3",
    );
    expect(sha256(AMA_BENCH_ANSWER_PROMPT_TEMPLATE)).toBe(
      "2b69bd452419a83ec205779a283442094855e9b0476ab54a51c6316a57839ab5",
    );

    const { query, label, prediction } = identities();
    expect(buildAmaBenchEvaluatorInput(query, label, prediction)).toEqual({
      episode_id: 7,
      question_uuid: "11111111-1111-4111-8111-111111111111",
      task_type: "webarena",
      domain: "WEB",
      task_description: "Inspect the page and recover the final state.",
      question: "PRIVATE_QUESTION_TEXT",
      golden_answer: "GOLD_ANSWER_MUST_NOT_ESCAPE",
      predicted_answer: "The status became complete.",
      qa_type: "C",
    });

    expect(() => buildAmaBenchEvaluatorInput(query, label, {
      ...prediction,
      questionId: "22222222-2222-4222-8222-222222222222",
    })).toThrow(/identities differ/u);
  });

  it("emits official episode submissions in QA order", () => {
    const { prediction } = identities();
    const second: AmaBenchQuestionPrediction = {
      ...prediction,
      questionId: "22222222-2222-4222-8222-222222222222",
      questionIndex: 1,
      answer: "Second answer",
      reasoningTrace: "Second trace",
    };
    expect(buildAmaBenchEpisodeSubmissions([second, prediction])).toEqual([{
      episode_id: 7,
      answer_list: ["The status became complete.", "Second answer"],
      reasoning_trace: [
        "Question 1 (11111111-1111-4111-8111-111111111111)",
        "Selected the state update at Step 0.",
        "",
        "Question 2 (22222222-2222-4222-8222-222222222222)",
        "Second trace",
      ].join("\n"),
    }]);

    expect(() => buildAmaBenchEpisodeSubmissions([{
      ...prediction,
      questionIndex: 1,
    }])).toThrow(/contiguous from zero/u);
  });
});
