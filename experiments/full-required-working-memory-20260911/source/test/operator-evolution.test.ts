import { describe, expect, it } from "vitest";
import {
  OperatorEvolutionCatalog,
  type PicorerResult,
} from "../src/evidence-agent/index.js";
import type {
  SearchOperatorDefinition,
  SearchOperatorDefinitionSnapshot,
} from "../src/retrieval/index.js";
import { sha256 } from "../src/util.js";

function definition(
  id: string,
  queries?: string[],
): SearchOperatorDefinition {
  return {
    id,
    version: "run-1",
    guide: {
      summary: `Reusable plan ${id}`,
      useWhen: ["Evidence needs complementary recall."],
      cost: "medium",
    },
    steps: [
      {
        id: "recall",
        kind: "search",
        operator: "hybrid",
        ...(queries === undefined ? {} : { queries }),
      },
      { id: "distinct", kind: "dedupe", input: "recall", by: "content" },
    ],
    output: "distinct",
  };
}

function snapshot(source: SearchOperatorDefinition): SearchOperatorDefinitionSnapshot {
  return {
    revision: 1,
    definitionHash: sha256(JSON.stringify(source)),
    definition: source,
  };
}

function result(
  source: SearchOperatorDefinition,
  options: {
    status?: "sufficient" | "insufficient";
    cited?: boolean;
    executed?: boolean;
  } = {},
): PicorerResult {
  const operator = snapshot(source);
  const cited = options.cited ?? true;
  const executed = options.executed ?? true;
  return {
    runId: "run-1",
    scopeId: "scope-1",
    question: "Which evidence applies?",
    status: options.status ?? "sufficient",
    citations: cited ? [{ memoryId: "memory-1", supports: "Direct fact." }] : [],
    evidenceSummary: cited ? "Direct fact." : "No evidence.",
    candidates: [],
    evidence: [],
    trace: executed
      ? [{
        step: 1,
        toolCallId: "search-1",
        toolName: "search",
        args: { operator: source.id },
        isError: false,
        details: {
          kind: "search",
          operator: source.id,
          composition: { definitionHash: operator.definitionHash },
          candidateReferences: [{ candidateRef: 1, memoryId: "memory-1" }],
        },
      }]
      : [],
    operatorCatalog: { revision: 1, hash: "a".repeat(64) },
    operatorDefinitions: [operator],
    metrics: {
      searchCalls: executed ? 1 : 0,
      readCalls: cited ? 1 : 0,
      bashCalls: 0,
      operatorDefinitionCalls: 1,
      candidateCount: executed ? 1 : 0,
      inspectedEvidenceCount: cited ? 1 : 0,
      evidenceCount: cited ? 1 : 0,
      citedCount: cited ? 1 : 0,
      retrievalProfile: "fts5",
      embeddingCalls: 0,
      embeddingLatencyMs: 0,
      denseCandidateCount: 0,
      rerankCandidateCount: 0,
      denseFallbackCount: 0,
      expiredNavigationResults: 0,
      compactedReadResults: 0,
    },
    retrieval: { retrievalProfile: "fts5" },
    retrievalModel: {
      providerId: "test",
      modelId: "test",
      responseModels: ["test"],
      thinkingLevel: "off",
      transport: "non-stream",
    },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("OperatorEvolutionCatalog", () => {
  it("admits only query-agnostic plans that contributed cited evidence", () => {
    const catalog = new OperatorEvolutionCatalog();
    const reusable = definition("reusable");
    const admitted = catalog.observe("q-1", result(reusable));

    expect(admitted.decisions).toEqual([
      expect.objectContaining({ action: "admitted", reason: "evidence-contributing" }),
    ]);
    expect(catalog.definitionsForNextQuestion()).toEqual([reusable]);
    expect(catalog.snapshot().entries[0]).toMatchObject({
      phase: "provisional",
      successfulQuestionIds: ["q-1"],
    });

    const bound = definition("answer-shaped", ["the guessed final answer"]);
    const rejected = catalog.observe("q-2", result(bound));
    expect(rejected.decisions).toEqual([
      expect.objectContaining({ action: "rejected", reason: "query-bound-definition" }),
    ]);
    expect(catalog.definitionsForNextQuestion()).toEqual([reusable]);
  });

  it("promotes after evidence contribution on two distinct questions", () => {
    const catalog = new OperatorEvolutionCatalog({ promotionQuestions: 2 });
    const reusable = definition("reusable");
    catalog.observe("q-1", result(reusable));
    const observation = catalog.observe("q-2", result(reusable));

    expect(observation.decisions).toEqual([
      expect.objectContaining({ action: "credited", reason: "evidence-contributing" }),
    ]);
    expect(catalog.snapshot().entries[0]).toMatchObject({
      phase: "promoted",
      executedQuestionIds: ["q-1", "q-2"],
      successfulQuestionIds: ["q-1", "q-2"],
      executions: 2,
    });
  });

  it("credits cited evidence revealed by search_more without double-counting execution", () => {
    const catalog = new OperatorEvolutionCatalog();
    const reusable = definition("paged");
    const paged = result(reusable);
    const hash = snapshot(reusable).definitionHash;
    paged.trace = [
      {
        step: 1,
        toolCallId: "search-1",
        toolName: "search",
        args: { operator: reusable.id },
        isError: false,
        details: {
          kind: "search",
          operator: reusable.id,
          composition: { definitionHash: hash },
          candidateReferences: [{ candidateRef: "C1", memoryId: "memory-0" }],
        },
      },
      {
        step: 2,
        toolCallId: "search-more-1",
        toolName: "search_more",
        args: {},
        isError: false,
        details: {
          kind: "search",
          operator: reusable.id,
          composition: { definitionHash: hash },
          candidateReferences: [{ candidateRef: "C2", memoryId: "memory-1" }],
        },
      },
    ];

    expect(catalog.observe("q-paged", paged).decisions).toEqual([
      expect.objectContaining({
        action: "admitted",
        reason: "evidence-contributing",
        citedMemoryIds: ["memory-1"],
      }),
    ]);
    expect(catalog.snapshot().entries[0]).toMatchObject({
      executions: 1,
      citedMemoryIds: ["memory-1"],
    });
  });

  it("credits a directly cited compact-directory candidate once", () => {
    const catalog = new OperatorEvolutionCatalog();
    const reusable = definition("directory-cited");
    const paged = result(reusable);
    const hash = snapshot(reusable).definitionHash;
    paged.trace = [{
      step: 1,
      toolCallId: "search-directory",
      toolName: "search",
      args: { operator: reusable.id },
      isError: false,
      details: {
        kind: "search",
        operator: reusable.id,
        composition: { definitionHash: hash },
        candidateReferences: [{ candidateRef: "C1", memoryId: "memory-0" }],
        directoryCandidateReferences: [
          { candidateRef: "C2", memoryId: "memory-1" },
          { candidateRef: "C3", memoryId: "memory-1" },
        ],
      },
    }];

    expect(catalog.observe("q-directory", paged).decisions).toEqual([
      expect.objectContaining({
        action: "admitted",
        reason: "evidence-contributing",
        citedMemoryIds: ["memory-1"],
      }),
    ]);
    expect(catalog.snapshot().entries[0]).toMatchObject({
      executions: 1,
      citedMemoryIds: ["memory-1"],
    });
  });

  it("does not admit unused, uncited, or insufficient plans", () => {
    const cases = [
      ["unused", { executed: false }, "not-executed"],
      ["uncited", { cited: false }, "no-cited-candidate"],
      ["insufficient", { status: "insufficient" as const }, "insufficient-result"],
    ] as const;
    for (const [id, options, reason] of cases) {
      const catalog = new OperatorEvolutionCatalog();
      const observation = catalog.observe(id, result(definition(id), options));
      expect(observation.decisions[0]).toMatchObject({ action: "rejected", reason });
      expect(catalog.definitionsForNextQuestion()).toEqual([]);
    }
  });

  it("reserves exploration capacity, round-trips state, and rejects replay", () => {
    const catalog = new OperatorEvolutionCatalog({ capacity: 3, explorationSlots: 1 });
    for (const id of ["alpha", "beta", "gamma"]) {
      catalog.observe(`q-${id}`, result(definition(id)));
    }
    expect(catalog.maxDefinitionsForRun()).toBe(3);
    expect(catalog.definitionsForNextQuestion()).toHaveLength(2);

    const restored = OperatorEvolutionCatalog.restore(catalog.snapshot());
    expect(restored.snapshot()).toEqual(catalog.snapshot());
    expect(restored.definitionsForNextQuestion()).toEqual(
      catalog.definitionsForNextQuestion(),
    );
    expect(() => restored.observe("q-alpha", result(definition("alpha"))))
      .toThrow(/already observed/iu);
  });
});
