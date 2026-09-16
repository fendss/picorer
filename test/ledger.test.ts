import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../src/evidence-agent/index.js";
import {
  MAX_INSPECTED_EVIDENCE_CHARS,
  projectMemoryEvidence,
} from "../src/evidence-agent/index.js";
import type { StoreSearchHit } from "../src/platform/sqlite/picorer-store.js";
import type { MemoryRecord } from "../src/memory/index.js";

function record(
  memoryId: string,
  turnIndex: number,
  scopeId = "scope-1",
): MemoryRecord {
  return {
    memoryId,
    scopeId,
    sessionId: "session-1",
    turnIndex,
    role: turnIndex % 2 === 0 ? "user" : "assistant",
    content: `raw content for ${memoryId}`,
    contentHash: `hash-${memoryId}`,
    metadata: {},
  };
}

function hit(memory: MemoryRecord, rank: number): StoreSearchHit {
  return {
    record: memory,
    query: "raw content",
    retriever: "fts5",
    rank,
    score: 10 - rank,
    preview: memory.content,
  };
}

function evidence(records: readonly MemoryRecord[]) {
  return records.map((item) => projectMemoryEvidence(item, [item.content], 4_096));
}

describe("MemoryLedger", () => {
  it("assigns one stable evidence reference per parent within a repeated batch", () => {
    const ledger = new MemoryLedger("scope-1");
    const first = record("m1", 0);
    const second = record("m2", 1);
    ledger.recordInspect(evidence([first, first, second]));
    expect(ledger.evidenceRef("m1")).toBe("E1");
    expect(ledger.evidenceRef("m2")).toBe("E2");
    expect(ledger.inspectedEvidence).toHaveLength(2);
  });

  it.each(["search", "bash"] as const)("rejects a mixed-scope %s batch without keeping a partial result", (tool) => {
    const ledger = new MemoryLedger("scope-1");
    const records = [record("local", 0), record("foreign", 0, "scope-2")];
    expect(() => tool === "search"
      ? ledger.recordSearchHits(records.map(hit))
      : ledger.recordBashDiscoveries(records, "offline test")).toThrow("expected scope-1");
    expect(ledger.candidates).toEqual([]);
    ledger.recordSearchHits([hit(records[0]!, 1)]);
    expect(ledger.candidateRef("local")).toBe("C1");
  });

  it("isolates nested source metadata from callers and returned evidence", () => {
    const ledger = new MemoryLedger("scope-1");
    const source = record("m1", 0);
    source.metadata = { provenance: { tags: ["original"] } };
    const [input] = evidence([source]);
    const [returned] = ledger.recordInspect([input!]);
    const tags = (value: { metadata: Record<string, unknown> }) =>
      (value.metadata.provenance as { tags: string[] }).tags;
    tags(input!).push("input mutation");
    tags(returned!).push("result mutation");
    tags(ledger.inspectedEvidence[0]!).push("getter mutation");
    expect(tags(ledger.inspectedEvidence[0]!)).toEqual(["original"]);
  });

  it("keeps committed citations equal to read evidence within candidates", () => {
    const ledger = new MemoryLedger("scope-1");
    const first = record("m1", 0);
    const searchOnly = record("m2", 1);
    const expanded = record("m3", 2);

    ledger.recordSearchHits([hit(first, 1), hit(searchOnly, 2)]);
    ledger.recordInspect(evidence([first, expanded]));
    ledger.finish({
      status: "sufficient",
      citations: [
        { memoryId: first.memoryId, supports: "First source" },
        { memoryId: expanded.memoryId, supports: "Direct support" },
      ],
      evidenceSummary: "The expanded neighboring turn contains the answer.",
    });

    expect(ledger.candidates.map((candidate) => candidate.memoryId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(ledger.inspectedEvidence.map((memory) => memory.memoryId)).toEqual([
      "m1",
      "m3",
    ]);
    expect(ledger.citations.map((citation) => citation.memoryId)).toEqual([
      "m1",
      "m3",
    ]);

    const expandedCandidate = ledger.candidates.find(
      (candidate) => candidate.memoryId === "m3",
    );
    expect(expandedCandidate?.inspected).toBe(true);
    expect(expandedCandidate?.committed).toBe(true);
    expect(expandedCandidate?.discoveries).toEqual([
      expect.objectContaining({ tool: "read_expansion" }),
    ]);
    expect(
      ledger.candidates.find((candidate) => candidate.memoryId === "m1")?.committed,
    ).toBe(true);
    expect(
      ledger.candidates.find((candidate) => candidate.memoryId === "m2")?.inspected,
    ).toBe(false);
    expect(() => ledger.assertInvariants()).not.toThrow();
  });

  it("accepts an identical duplicate finish idempotently", () => {
    const ledger = new MemoryLedger("scope-1");
    const candidate = record("m1", 0);
    ledger.recordSearchHits([hit(candidate, 1)]);
    ledger.recordInspect(evidence([candidate]));
    const selection = {
      status: "sufficient" as const,
      citations: [{ memoryId: "m1", supports: "Direct support" }],
      evidenceSummary: "The source provides direct support.",
    };

    expect(ledger.finish(selection)).toEqual(selection);
    expect(ledger.finish(selection)).toEqual(selection);
    expect(() => ledger.finish({
      ...selection,
      evidenceSummary: "A different selection.",
    })).toThrow(/different evidence selection/u);
  });

  it("rejects sufficient selections without citations", () => {
    const ledger = new MemoryLedger("scope-1");
    expect(() =>
      ledger.finish({
        status: "sufficient",
        citations: [],
        evidenceSummary: "No evidence.",
      }),
    ).toThrow(/at least one memory/u);
  });

  it("rejects citations that were found but not inspected", () => {
    const ledger = new MemoryLedger("scope-1");
    const candidate = record("m1", 0);
    ledger.recordSearchHits([hit(candidate, 1)]);

    expect(() =>
      ledger.finish({
        status: "sufficient",
        citations: [{ memoryId: "m1", supports: "Search preview" }],
        evidenceSummary: "Only a preview was seen.",
      }),
    ).toThrow(/inspected in this run/u);
  });

  it("rejects duplicate citations", () => {
    const ledger = new MemoryLedger("scope-1");
    const candidate = record("m1", 0);
    ledger.recordInspect(evidence([candidate]));

    expect(() => ledger.finish({
      status: "sufficient",
      citations: [
        { memoryId: "m1", supports: "First statement." },
        { memoryId: "m1", supports: "Repeated statement." },
      ],
      evidenceSummary: "Repeated source.",
    })).toThrow(/Duplicate citation/u);
  });

  it("rejects a handoff that omits any source returned by read", () => {
    const ledger = new MemoryLedger("scope-1");
    const first = record("m1", 0);
    const second = record("m2", 1);
    ledger.recordInspect(evidence([first, second]));

    expect(() => ledger.finish({
      status: "sufficient",
      citations: [{ memoryId: "m1", supports: "First statement." }],
      evidenceSummary: "One read source was omitted.",
    })).toThrow(/every exact source returned by read/u);
  });

  it("accepts and commits the complete read ledger beyond the former selection limit", () => {
    const ledger = new MemoryLedger("scope-1");
    const sources = Array.from({ length: 33 }, (_, index) => ({
      ...record(`m-${String(index)}`, index),
      content: "x".repeat(8_192),
    }));
    ledger.recordInspect(sources.map((source) =>
      projectMemoryEvidence(source, ["x"], 8_192)
    ));
    expect(ledger.inspectedEvidence).toHaveLength(33);
    expect(() => ledger.finish({
      status: "sufficient",
      citations: sources.map((source) => ({
        memoryId: source.memoryId,
        supports: source.memoryId,
      })),
      evidenceSummary: "All read sources are committed.",
    })).not.toThrow();
    expect(ledger.citations).toHaveLength(33);
    expect(ledger.candidates.every((candidate) => candidate.committed)).toBe(true);
  });

  it("rejects an over-size inspect atomically before it enters the private ledger", () => {
    const ledger = new MemoryLedger("scope-1");
    const admitted = Array.from({ length: 127 }, (_, index) => ({
      ...record(`m-large-${String(index)}`, index),
      content: "x".repeat(8_192),
    }));
    ledger.recordInspect(admitted.map((source) =>
      projectMemoryEvidence(source, [], 8_192)
    ));
    const overflow = {
      ...record("m-large-overflow", 127),
      content: "x".repeat(8_193),
    };

    expect(() => ledger.recordInspect([
      projectMemoryEvidence(overflow, [], 8_192),
    ])).toThrow(new RegExp(
      `limit of ${String(MAX_INSPECTED_EVIDENCE_CHARS)} characters`,
      "u",
    ));
    expect(ledger.inspectedEvidence).toHaveLength(127);
    expect(ledger.candidates.some((item) => item.memoryId === overflow.memoryId))
      .toBe(false);
  });

  it("retains distinct exact passages when a long memory is inspected twice", () => {
    const ledger = new MemoryLedger("scope-1");
    const content =
      `${"h".repeat(10_000)} FIRST_UNIQUE ${"x".repeat(20_000)}` +
      ` SECOND_UNIQUE ${"y".repeat(10_000)}`;
    const source = {
      ...record("m-long", 0),
      content,
      contentHash: "hash-m-long",
    };
    const first = projectMemoryEvidence(source, ["FIRST_UNIQUE"], 8_192);
    const second = projectMemoryEvidence(source, ["SECOND_UNIQUE"], 8_192);
    expect(first.content).toContain("FIRST_UNIQUE");
    expect(first.content).not.toContain("SECOND_UNIQUE");
    expect(second.content).not.toContain("FIRST_UNIQUE");
    expect(second.content).toContain("SECOND_UNIQUE");

    ledger.recordInspect([first]);
    ledger.recordInspect([second]);

    expect(ledger.inspectedEvidence).toHaveLength(1);
    expect(ledger.inspectedEvidence[0]?.content).toContain("FIRST_UNIQUE");
    expect(ledger.inspectedEvidence[0]?.content).toContain("SECOND_UNIQUE");
    expect(ledger.evidenceRef(source.memoryId)).toBe("E1");
  });

  it("allows an insufficient selection with no citations", () => {
    const ledger = new MemoryLedger("scope-1");
    expect(
      ledger.finish({
        status: "insufficient",
        citations: [],
        evidenceSummary: "No sufficient source memory was found.",
      }),
    ).toEqual({
      status: "insufficient",
      citations: [],
      evidenceSummary: "No sufficient source memory was found.",
    });
  });

  it("preserves a source-backed count inventory in the decision", () => {
    const ledger = new MemoryLedger("scope-1");
    const first = record("m1", 0);
    const second = record("m2", 1);
    ledger.recordInspect(evidence([first, second]));

    expect(
      ledger.finish({
        status: "sufficient",
        citations: [
          { memoryId: "m1", supports: "First item." },
          { memoryId: "m2", supports: "Second item." },
        ],
        evidenceSummary: "Two distinct source-backed items.",
        count: 2,
        inventory: [
          { item: "first", memoryIds: ["m1"] },
          { item: "second", memoryIds: ["m2"] },
        ],
      }),
    ).toMatchObject({
      count: 2,
      inventory: [
        { item: "first", memoryIds: ["m1"] },
        { item: "second", memoryIds: ["m2"] },
      ],
    });
  });

  it("rejects inventory entries backed only by uninspected memory", () => {
    const ledger = new MemoryLedger("scope-1");
    const first = record("m1", 0);
    ledger.recordInspect(evidence([first]));

    expect(() =>
      ledger.finish({
        status: "sufficient",
        citations: [{ memoryId: "m1", supports: "First item." }],
        evidenceSummary: "An invalid inventory.",
        count: 2,
        inventory: [
          { item: "first", memoryIds: ["m1"] },
          { item: "second", memoryIds: ["m-uninspected"] },
        ],
      }),
    ).toThrow(/inspected in this run/u);
  });

  it("rejects records from another scope", () => {
    const ledger = new MemoryLedger("scope-1");
    const foreign = record("m1", 0, "scope-2");
    expect(() => ledger.recordInspect(evidence([foreign]))).toThrow(/expected scope-1/u);
  });

  it("records bash-discovered source IDs as candidates, not evidence", () => {
    const ledger = new MemoryLedger("scope-1");
    const discovered = record("m-bash", 3);
    const candidates = ledger.recordBashDiscoveries(
      [discovered],
      "grep -n needle memory.jsonl",
    );

    expect(candidates[0]).toMatchObject({
      memoryId: "m-bash",
      inspected: false,
      committed: false,
    });
    expect(candidates[0]?.discoveries[0]).toMatchObject({
      tool: "bash_ro",
      retriever: "bash_ro",
    });
    expect(ledger.inspectedEvidence).toEqual([]);
  });
});
