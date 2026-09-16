import { describe, expect, it } from "vitest";
import { MemoryLedger, projectMemoryEvidenceBatch } from "../src/evidence-agent/index.js";
import { sourcePreviewSpans, candidatePreview } from "../src/evidence-agent/model/source-preview-spans.js";
import { createPicorerTools } from "../src/evidence-agent/adapters/pi/tools.js";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import { memoryPassages, type RetrievalHit } from "../src/retrieval/index.js";
import { renderMemoryArenaEvidencePrompt } from "../src/benchmark/memoryarena-public/index.js";
import { sha256 } from "../src/util.js";
import type { MemoryRecord } from "../src/memory/index.js";

function record(content: string): MemoryRecord {
  return { memoryId: "m1", scopeId: "scope", sessionId: "s", turnIndex: 0,
    role: "other", content, contentHash: sha256(content), metadata: {} };
}

function hit(source: MemoryRecord, preview: string, rank = 1): RetrievalHit {
  return { record: source, preview, rank, score: 1, retriever: "fts5", query: "target" };
}

function setup(source: MemoryRecord) {
  const ledger = new MemoryLedger("scope");
  const store = { search: () => [], read: () => [source] };
  const tools = createPicorerTools({ store, ledger, scopeId: "scope", maxSearchCalls: 4,
    operatorRegistry: createSearchOperatorRegistry(store) });
  return { ledger, tools, store };
}

describe("source fragments survive evidence transfer", () => {
  it("maps compact whitespace and literal punctuation to exact UTF-16 source offsets", () => {
    const source = "🙂 prefix A [x].\n\tB (y)? trailing";
    const spans = sourcePreviewSpans(source, "… A [x]. B (y)? …");
    expect(spans).toEqual([{ start: source.indexOf("A [x]"), end: source.indexOf(" trailing") }]);
    expect(sourcePreviewSpans(source, "The answer is unavailable.")).toEqual([]);
    expect(sourcePreviewSpans("same same", "same")).toEqual([{ start: 0, end: 4 }]);
  });

  it("bounds oversized legacy previews consistently without clipping exact passages", () => {
    const source = record(`${"noise ".repeat(4000)}target unique fact.`);
    const bounded = candidatePreview(hit(source, source.content));
    expect(bounded.length).toBeLessThanOrEqual(360);
    expect(bounded).toContain("target");
    const passage = memoryPassages(source).at(-1)!;
    expect(candidatePreview({ ...hit(source, "ignored"), passage })).toBe(passage.content);
  });

  it("retains earlier and later search fragments through read, reread, finish and handoff", async () => {
    const first = "First unique fact.";
    const second = "Second unique fact.";
    const source = record(`${"x".repeat(10000)}${first}${"y".repeat(10000)}${second}${"z".repeat(140000)}`);
    const { ledger, tools } = setup(source);
    ledger.recordSearchHits([hit(source, first)]);
    await tools.read.execute("r1", { candidateRefs: ["C1"], contextBefore: 0, contextAfter: 0 });
    const before = ledger.inspectedEvidence[0]!.excerpts;
    // A worse ranked discovery leaves the public best-rank preview unchanged.
    ledger.recordSearchHits([hit(source, second, 8)]);
    expect(ledger.candidates[0]!.preview).toBe(first);
    const read = await tools.read.execute("r2", { candidateRefs: ["C1"], contextBefore: 0, contextAfter: 0 });
    expect(JSON.stringify(read.content)).toContain(first);
    expect(JSON.stringify(read.content)).toContain(second);
    const finish = await tools.finish.execute("f", { status: "sufficient" });
    const evidence = ledger.inspectedEvidence;
    for (const old of before) expect(evidence[0]!.excerpts.some(e => e.start <= old.start && e.end >= old.end)).toBe(true);
    const prompt = renderMemoryArenaEvidencePrompt("question", {
      runId: "test", ...finish.details.selection, evidence, trace: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }, new Map([[source.memoryId, source.content]]));
    expect(prompt).toContain(first);
    expect(prompt).toContain(second);
    for (const e of evidence[0]!.excerpts) expect(prompt).toContain(e.content);
  });

  it("promotes a selected passage without hiding unread sibling passages", async () => {
    const source = record(`head fact.\n${"noise ".repeat(3000)}tail fact.`);
    const { ledger, tools } = setup(source);
    const passage = memoryPassages(source).at(-1)!;
    ledger.recordSearchHits([hit(source, "head fact."), { ...hit(source, passage.content), passage }]);
    await tools.read.execute("r", { candidateRefs: ["C2"], contextBefore: 0, contextAfter: 0 });
    expect(ledger.inspectedEvidence[0]!.content).toContain("head fact.");
    expect(ledger.inspectedEvidence[0]!.content).toContain("tail fact.");
    expect(ledger.resolveCandidates(["C2"])[0]?.inspected).toBe(true);
    expect(ledger.resolveCandidates(["C1"])[0]?.inspected).toBe(false);
  });

  it("rejects impossible preservation atomically instead of silently dropping source fragments", async () => {
    const fragments = Array.from({ length: 240 }, (_, i) => `fact-${i}: ${String(i % 10).repeat(290)}.`);
    const source = record(fragments.join("\n") + "x".repeat(10000));
    const { ledger, tools } = setup(source);
    for (const preview of fragments) ledger.recordSearchHits([hit(source, preview)]);
    await expect(tools.read.execute("r", { candidateRefs: ["C1"], contextBefore: 0, contextAfter: 0 }))
      .rejects.toThrow(/budget/i);
    expect(ledger.inspectedEvidence).toEqual([]);
    expect(ledger.candidates[0]!.inspected).toBe(false);
  });

  it("allows an empty immutable parent with its empty passage", async () => {
    const source = record("");
    const { ledger, tools } = setup(source);
    ledger.recordSearchHits([hit(source, ""), { ...hit(source, ""), passage: memoryPassages(source)[0]! }]);
    await tools.read.execute("r", { candidateRefs: ["C1", "C2"], contextBefore: 0, contextAfter: 0 });
    expect(ledger.inspectedEvidence[0]!.content).toBe("");
  });

  it("fits mandatory spans alone when marker overhead exhausts optional context", () => {
    const source = record("x".repeat(10000));
    const evidence = projectMemoryEvidenceBatch([source], () => [], 200, () => [{ start: 8000, end: 8140 }]);
    expect(evidence[0]!.content.length).toBeLessThanOrEqual(200);
    expect(evidence[0]!.excerpts).toEqual([{ start: 8000, end: 8140, content: "x".repeat(140) }]);
    expect(() => projectMemoryEvidenceBatch([source], () => [], 200, () => [{ start: -1, end: 20 }])).toThrow(/Invalid/);
  });

  it("rejects changed or missing selected sources before recording a successful read", async () => {
    const source = record("exact fact");
    const { ledger, tools, store } = setup(source);
    ledger.recordSearchHits([hit(source, source.content)]);
    store.read = () => [record("changed fact")];
    await expect(tools.read.execute("r", { candidateRefs: ["C1"] })).rejects.toThrow(/source changed/);
    store.read = () => [];
    await expect(tools.read.execute("r", { candidateRefs: ["C1"] })).rejects.toThrow(/selected parent/);
    expect(ledger.inspectedEvidence).toEqual([]);
  });
});
