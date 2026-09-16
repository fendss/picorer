import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../src/memory/index.js";
import {
  createSearchMemory,
  MAX_PASSAGE_CHARS,
  memoryPassages,
  projectSearchHitsToPassages,
  type EvidenceOperatorResult,
  type RetrievalHit,
  type SearchOperatorCatalog,
} from "../src/retrieval/index.js";
import {
  MemoryLedger,
  projectMemoryEvidence,
  projectPassageEvidence,
} from "../src/evidence-agent/index.js";
import { renderEvidenceOperator } from "../src/evidence-agent/adapters/pi/tools/render-tool-result.js";
import { sha256 } from "../src/util.js";

function record(content: string): MemoryRecord {
  return {
    memoryId: "parent-1",
    scopeId: "scope-1",
    sessionId: "session-1",
    turnIndex: 0,
    role: "user",
    content,
    contentHash: sha256(content),
    metadata: {},
  };
}

function parentHit(source: MemoryRecord, queries: string[]): RetrievalHit {
  return {
    record: source,
    query: queries[0]!,
    matchedQueries: queries,
    retriever: "fts5",
    rank: 1,
    score: 1,
    preview: "legacy parent preview",
  };
}

describe("source-bound passage retrieval", () => {
  it("creates deterministic bounded sentence passages without duplicating a short source", () => {
    const short = record("First fact. Second fact. Third fact.");
    const first = memoryPassages(short);
    const second = memoryPassages(short);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      parentMemoryId: short.memoryId,
      start: 0,
      end: short.content.length,
      content: short.content,
    });

    const long = record([
      `Alpha fact ${"a".repeat(600)}. `,
      `Bridge fact ${"b".repeat(600)}. `,
      `Gamma fact ${"c".repeat(600)}.`,
    ].join(""));
    const passages = memoryPassages(long);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((passage) =>
      passage.content === long.content.slice(passage.start, passage.end)
    )).toBe(true);
    expect(passages.every((passage) =>
      passage.content.length <= MAX_PASSAGE_CHARS
    )).toBe(true);

    const chinese = record(
      `第一句${"甲".repeat(900)}。第二句${"乙".repeat(900)}。`,
    );
    const chinesePassages = memoryPassages(chinese);
    expect(chinesePassages).toHaveLength(2);
    expect(chinesePassages[0]?.content.endsWith("。")).toBe(true);
    expect(chinesePassages[1]?.content.startsWith("第二句")).toBe(true);
  });

  it("uses the requested limit for passage candidates and keeps parent provenance", () => {
    const source = record([
      `alphaMarker ${"a".repeat(1_300)}. `,
      `middle ${"m".repeat(1_300)}. `,
      `betaMarker ${"b".repeat(1_300)}.`,
    ].join(""));
    const projected = projectSearchHitsToPassages(
      [parentHit(source, ["alphaMarker", "betaMarker"])],
      2,
    );

    expect(projected).toHaveLength(2);
    expect(projected.map((hit) => hit.record.memoryId)).toEqual([
      source.memoryId,
      source.memoryId,
    ]);
    expect(new Set(projected.map((hit) => hit.passage?.passageId)).size).toBe(2);
    expect(projected.map((hit) => hit.preview).join(" ")).toContain("alphaMarker");
    expect(projected.map((hit) => hit.preview).join(" ")).toContain("betaMarker");
    expect(projectSearchHitsToPassages(projected, 1)).toHaveLength(1);
  });

  it("keeps parent candidates by default and requires passage projection explicitly", async () => {
    const source = record([
      `alphaMarker ${"a".repeat(1_300)}. `,
      `betaMarker ${"b".repeat(1_300)}.`,
    ].join(""));
    const catalog: SearchOperatorCatalog = {
      defaultOperatorId: "parent-default",
      get() {
        return {
          id: "parent-default",
          version: "1",
          guide: { summary: "test", useWhen: ["test"], cost: "low" },
          execute(_context, input) {
            return Promise.resolve({
              request: { queries: input.queries, limit: input.limit },
              hits: [parentHit(source, input.queries)],
            });
          },
        };
      },
      list() {
        return [];
      },
    };
    const input = { queries: ["betaMarker"], limit: 1 };
    const parent = await createSearchMemory({
      operatorRegistry: catalog,
      scopeId: source.scopeId,
    })(input);
    const passage = await createSearchMemory({
      operatorRegistry: catalog,
      scopeId: source.scopeId,
      passageProjection: true,
    })(input);

    expect(parent.hits[0]?.passage).toBeUndefined();
    expect(parent.hits[0]?.preview).toContain("betaMarker");
    expect(passage.hits[0]?.passage).toBeDefined();
    expect(passage.hits[0]?.preview).toContain("betaMarker");
  });

  it("keeps one parent candidate and shows its query-consensus span", async () => {
    const source = record([
      "General shopping advice covers promotions, purchases, and order confirmations. ",
      "Unrelated maintenance notes. ".repeat(100),
      "I currently have five blue widgets from Atlas & Co.",
    ].join(""));
    const catalog: SearchOperatorCatalog = {
      defaultOperatorId: "multi-span-parent",
      get() {
        return {
          id: "multi-span-parent",
          version: "1",
          guide: { summary: "test", useWhen: ["test"], cost: "low" },
          execute(_context, input) {
            return Promise.resolve({
              request: { queries: input.queries, limit: input.limit },
              hits: [parentHit(source, input.queries)],
            });
          },
        };
      },
      list() {
        return [];
      },
    };

    const result = await createSearchMemory({
      operatorRegistry: catalog,
      scopeId: source.scopeId,
    })({
      queries: [
        "Atlas & Co blue widgets bought",
        "purchase Atlas & Co widget",
        "I bought widgets Atlas & Co",
        "widget order confirmation",
      ],
      limit: 1,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.record.memoryId).toBe(source.memoryId);
    expect(result.hits[0]?.preview).toContain("five blue widgets from Atlas & Co");
    expect(result.hits[0]?.preview).not.toContain("General shopping advice");
  });

  it("keeps parent breadth when primaries fill the limit and reapplies a session cap", () => {
    const content = [
      `alphaMarker ${"a".repeat(1_300)}. `,
      `betaMarker ${"b".repeat(1_300)}.`,
    ].join("");
    const first = record(content);
    const second = {
      ...record(content),
      memoryId: "parent-2",
      sessionId: "session-2",
    };
    const breadth = projectSearchHitsToPassages([
      parentHit(first, ["alphaMarker", "betaMarker"]),
      parentHit(second, ["alphaMarker", "betaMarker"]),
    ], 2);
    expect(breadth.map((hit) => hit.record.memoryId)).toEqual([
      "parent-1",
      "parent-2",
    ]);

    const capped = projectSearchHitsToPassages(
      [parentHit(first, ["alphaMarker", "betaMarker"])],
      2,
      new Map(),
      1,
    );
    expect(capped).toHaveLength(1);
  });

  it("keeps a semantic-only parent hit on the bounded legacy read path", () => {
    const source = record([
      `first topic ${"a".repeat(1_500)}. `,
      `answer topic ${"b".repeat(1_500)}.`,
    ].join(""));
    const hit = parentHit(source, ["different semantic wording"]);
    const [projected] = projectSearchHitsToPassages([hit], 1);

    expect(projected?.passage).toBeUndefined();
    expect(projected?.preview).toBe(hit.preview);

    const [focused] = projectSearchHitsToPassages([
      parentHit(source, ["answer topic"]),
    ], 1);
    const ledger = new MemoryLedger(source.scopeId);
    ledger.recordSearchHits([projected!]);
    const [focusedCandidate] = ledger.recordSearchHits([focused!]);
    ledger.recordInspect([
      projectPassageEvidence(source, focusedCandidate!.passage!),
    ], undefined, [focusedCandidate!.candidateId]);
    expect(() => ledger.finish({
      status: "sufficient",
      citations: [{ memoryId: source.memoryId, supports: "answer topic" }],
      evidenceSummary: "The focused passage contains the answer topic.",
    })).not.toThrow();
  });

  it("assigns separate candidate refs to passages but merges exact evidence by parent", () => {
    const source = record([
      `alphaMarker ${"a".repeat(1_300)}. `,
      `middle ${"m".repeat(1_300)}. `,
      `betaMarker ${"b".repeat(1_300)}.`,
    ].join(""));
    const hits = projectSearchHitsToPassages(
      [parentHit(source, ["alphaMarker", "betaMarker"])],
      2,
    );
    const ledger = new MemoryLedger(source.scopeId);
    const candidates = ledger.recordSearchHits(hits);

    expect(candidates.map((candidate) => candidate.memoryId)).toEqual([
      source.memoryId,
      source.memoryId,
    ]);
    expect(candidates.map((candidate) =>
      ledger.candidateRef(candidate.candidateId)
    )).toEqual(["C1", "C2"]);

    const first = projectPassageEvidence(source, candidates[0]!.passage!);
    ledger.recordInspect([first], undefined, [candidates[0]!.candidateId]);
    expect(ledger.candidates.map((candidate) => candidate.inspected)).toEqual([
      true,
      false,
    ]);

    const second = projectPassageEvidence(source, candidates[1]!.passage!);
    ledger.recordInspect([second], undefined, [candidates[1]!.candidateId]);
    expect(ledger.inspectedEvidence).toHaveLength(1);
    expect(ledger.inspectedEvidence[0]?.memoryId).toBe(source.memoryId);
    expect(ledger.inspectedEvidence[0]?.content).toContain("alphaMarker");
    expect(ledger.inspectedEvidence[0]?.content).toContain("betaMarker");
  });

  it("rejects a passage identity that was detached from its immutable offset", () => {
    const source = record(`answerMarker ${"x".repeat(2_000)}.`);
    const passage = memoryPassages(source)[0]!;
    expect(() => projectPassageEvidence(source, {
      ...passage,
      passageId: "P-tampered",
    })).toThrow(/does not match immutable parent/u);
  });

  it("binds a structured operator row to the passage containing its source quote", async () => {
    const quote = "The verified account balance is exactly $987 today.";
    const source = record([
      `account overview ${"head ".repeat(350)}. `,
      `unrelated history ${"middle ".repeat(350)}. `,
      quote,
    ].join(""));
    const operatorResult: EvidenceOperatorResult = {
      version: "picorer-evidence-operators-v1",
      operator: "numeric",
      rows: [{
        slot: "balance",
        quote,
        memoryId: source.memoryId,
        sessionId: source.sessionId,
        turnIndex: source.turnIndex,
        role: source.role,
        value: 987,
        unit: "USD",
        valueKind: "snapshot",
      }],
      coverage: {
        candidateCount: 1,
        distinctSessions: 1,
        truncated: false,
      },
    };
    const catalog: SearchOperatorCatalog = {
      defaultOperatorId: "anchored-test",
      get() {
        return {
          id: "anchored-test",
          version: "1",
          guide: {
            summary: "test",
            useWhen: ["test"],
            cost: "low",
          },
          execute(_context, input) {
            return Promise.resolve({
              request: { queries: input.queries, limit: input.limit },
              hits: [parentHit(source, input.queries)],
              operatorResult,
            });
          },
        };
      },
      list() {
        return [];
      },
    };
    const search = createSearchMemory({
      operatorRegistry: catalog,
      scopeId: source.scopeId,
      passageProjection: true,
    });
    const result = await search({
      operator: "anchored-test",
      queries: ["account overview"],
      limit: 1,
    });
    expect(result.hits[0]?.preview).toContain(quote);

    const ledger = new MemoryLedger(source.scopeId);
    const [candidate] = ledger.recordSearchHits(result.hits);
    const rendered = renderEvidenceOperator(result.operatorResult, ledger);
    const candidateRef = ledger.candidateRefForQuote(source.memoryId, quote);
    expect(rendered).toContain(`[candidate:${String(candidateRef)}]`);
    expect(candidateRef).toBe(ledger.candidateRef(candidate!.candidateId));

    const evidence = projectPassageEvidence(source, candidate!.passage!);
    ledger.recordInspect([evidence], undefined, [candidate!.candidateId]);
    expect(ledger.inspectedEvidence[0]?.content).toContain(quote);
  });

  it("uses direct primitive source spans when no annotated operator result exists", async () => {
    const fact = "The account contains exactly $987.";
    const source = record([
      `unrelated introduction ${"head ".repeat(350)}. `,
      `unrelated history ${"middle ".repeat(350)}. `,
      fact,
    ].join(""));
    const start = source.content.indexOf("$987");
    const directHit: RetrievalHit = {
      ...parentHit(source, ["database aggregate lookup"]),
      retriever: "picorer-aggregate-db",
      operatorNumericFactIndexes: [0],
      operatorSourceSpans: [{ start, end: start + "$987".length }],
    };
    const catalog: SearchOperatorCatalog = {
      defaultOperatorId: "numeric-index",
      get() {
        return {
          id: "numeric-index",
          version: "1",
          guide: {
            summary: "test",
            useWhen: ["test"],
            cost: "low",
          },
          execute(_context, input) {
            return Promise.resolve({
              request: { queries: input.queries, limit: input.limit },
              hits: [directHit],
            });
          },
        };
      },
      list() {
        return [];
      },
    };
    const result = await createSearchMemory({
      operatorRegistry: catalog,
      scopeId: source.scopeId,
      passageProjection: true,
    })({
      operator: "numeric-index",
      queries: ["database aggregate lookup"],
      limit: 1,
    });
    expect(result.operatorResult).toBeUndefined();
    expect(result.hits[0]?.preview).toContain(fact);

    const ledger = new MemoryLedger(source.scopeId);
    const [candidate] = ledger.recordSearchHits(result.hits);
    const evidence = projectPassageEvidence(source, candidate!.passage!);
    ledger.recordInspect([evidence], undefined, [candidate!.candidateId]);
    expect(ledger.inspectedEvidence[0]?.content).toContain(fact);
  });

  it("keeps unread passage candidates visible when a neighboring parent is expanded", () => {
    const firstSource = record(`selectedMarker ${"a".repeat(2_000)}.`);
    const neighborSource = {
      ...record(`neighborMarker ${"b".repeat(2_000)}.`),
      memoryId: "neighbor-parent",
      turnIndex: 1,
    };
    const hits = [
      ...projectSearchHitsToPassages(
        [parentHit(firstSource, ["selectedMarker"])],
        1,
      ),
      ...projectSearchHitsToPassages(
        [parentHit(neighborSource, ["neighborMarker"])],
        1,
      ),
    ];
    const ledger = new MemoryLedger(firstSource.scopeId);
    const candidates = ledger.recordSearchHits(hits);
    const selected = candidates[0]!;
    const neighbor = candidates[1]!;
    ledger.recordInspect([
      projectPassageEvidence(firstSource, selected.passage!),
      projectMemoryEvidence(neighborSource, ["neighborMarker"], 512),
    ], undefined, [selected.candidateId]);

    expect(ledger.selectCandidates([neighbor.candidateId])[0]?.inspected).toBe(false);
    const expansion = ledger.selectMemoryCandidates([neighborSource.memoryId])
      .find((candidate) => candidate.candidateId === neighborSource.memoryId);
    expect(expansion?.inspected).toBe(true);
    expect(expansion?.discoveries).toEqual([
      expect.objectContaining({ tool: "read_expansion" }),
    ]);
  });
});
