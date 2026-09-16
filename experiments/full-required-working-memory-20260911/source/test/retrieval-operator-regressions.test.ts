import { memoryPassages } from "../src/retrieval/model/passage.js";
import { temporalAnnotation } from "../src/retrieval/temporal-annotation.js";
import { explicitQueryDateFilter } from "../src/retrieval/structured-query-constraints.js";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import { createSearchMemory, type RetrievalHit, type SearchRequest, type SearchOperatorDefinition } from "../src/retrieval/index.js";
import { buildDeclarativeSearchOperator } from "../src/retrieval/use-cases/compose-operator.js";
import { finalizeSearchHits } from "../src/retrieval/finalize-search-hits.js";
import { parseSourceTimestamp } from "../src/retrieval/temporal-annotation.js";
import { extractTemporalFacts, resolveTemporalQuestion } from "../src/retrieval/operators/temporal-operator.js";
import { extractNumericFacts } from "../src/retrieval/operators/numeric-operator.js";
import { sha256 } from "../src/util.js";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";
import { renderEvidenceOperator } from "../src/evidence-agent/adapters/pi/tools/render-tool-result.js";
import { buildAggregateOperatorResult } from "../src/retrieval/operators/numeric-operator.js";

function record(id: string, role: MemoryRecord["role"] = "user", content = "shared topic"): MemoryRecord {
  return { memoryId: id, scopeId: "scope", sessionId: "session", turnIndex: 0,
    role, content, contentHash: sha256(content), metadata: {} };
}

function hit(source: MemoryRecord, rank = 1): RetrievalHit {
  return { record: source, query: "topic", retriever: "fts5", rank,
    score: 1 / rank, preview: source.content };
}

function fixture(records: MemoryRecord[]) {
  const search = vi.fn((_scope: string, request: SearchRequest) => {
    const counts = new Map<string, number>();
    return records.filter((source) => {
      if (request.roles !== undefined && !request.roles.includes(source.role)) return false;
      const count = counts.get(source.sessionId) ?? 0;
      counts.set(source.sessionId, count + 1);
      return request.maxPerSession === undefined || count < request.maxPerSession;
    }).slice(0, request.limit).map((source, index) => hit(source, index + 1));
  });
  return { search, catalog: createSearchOperatorRegistry({ search }) };
}

function definition(steps: SearchOperatorDefinition["steps"]): SearchOperatorDefinition {
  return { id: "review-plan", version: "1", guide: {
    summary: "Review fixture", useWhen: ["offline verification"], cost: "low",
  }, steps, output: steps.at(-1)!.id };
}

describe("retrieval operator boundary regressions", () => {

  it("rejects conflicting versions of one source across distinct retrieval branches", async () => {
    const { catalog } = fixture([record("same", "user", "original")]);
    vi.spyOn(catalog.get("lexical"), "execute").mockResolvedValue({ request: { queries: ["topic"] },
      hits: [hit(record("same", "user", "different source"))] });
    const search = createSearchMemory({ operatorRegistry: catalog, scopeId: "scope" });
    await expect(search({ queries: ["topic"], branches: [{ operator: "lexical", queries: ["topic"] }] }))
      .rejects.toThrow(/conflicting source/u);
  });

  it("reports actual fixed primitive queries through nested preloaded plans", async () => {
    const { catalog } = fixture([record("a")]);
    const run = catalog.forkForRun();
    run.define({ ...definition([{ id: "source", kind: "search", operator: "hybrid", queries: ["actual leaf query"] }]), id: "inner" });
    run.define({ ...definition([{ id: "source", kind: "search", operator: "inner" }]), id: "outer" });
    const search = createSearchMemory({ operatorRegistry: run, scopeId: "scope" });
    expect((await search({ operator: "outer", queries: ["unused caller query"] })).executedQueries).toEqual(["actual leaf query"]);
  });

  it("does not move a later role filter ahead of a lossy diversify or explicit combine limit", async () => {
    for (const cutoff of ["diversify", "combine"] as const) {
      const { catalog } = fixture([record("first", "assistant"), record("second")]);
      const steps: SearchOperatorDefinition["steps"] = [
        { id: "source", kind: "search", operator: "hybrid" },
        ...(cutoff === "diversify" ? [
          { id: "cut", kind: "diversify", input: "source", by: "session", maxPerGroup: 1 } as const,
        ] : [
          { id: "other", kind: "search", operator: "lexical" } as const,
          { id: "cut", kind: "combine", inputs: ["source", "other"] as string[], method: "union", limit: 1 } as const,
        ]),
        { id: "users", kind: "filter", input: "cut", roles: ["user"] },
      ];
      const plan = buildDeclarativeSearchOperator(catalog, definition(steps), 0).operator;
      expect((await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 10 })).hits).toEqual([]);
    }
  });

  it("uses the least restrictive session cap required by shared consumers", async () => {
    const { catalog } = fixture([record("a"), record("b"), record("c")]);
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid" },
      { id: "one", kind: "diversify", input: "source", by: "session", maxPerGroup: 1 },
      { id: "three", kind: "diversify", input: "source", by: "session", maxPerGroup: 3 },
      { id: "both", kind: "combine", inputs: ["one", "three"], method: "union" },
    ]), 0).operator;
    expect((await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 10 })).hits).toHaveLength(3);
  });

  it("restores relevance scores after chronological sorting", async () => {
    const { catalog } = fixture([
      { ...record("strong"), timestamp: "2024-02-02T00:00:00Z" },
      { ...record("weak"), timestamp: "2024-01-01T00:00:00Z" },
    ]);
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid" },
      { id: "time", kind: "sort", input: "source", order: "chronological" },
      { id: "score", kind: "sort", input: "time", order: "relevance" },
    ]), 0).operator;
    expect((await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 10 }))
      .hits.map((item) => item.record.memoryId)).toEqual(["strong", "weak"]);
  });

  it("preserves distinct passages from one parent across candidate fusion", async () => {
    const source = record("long", "user", "First topic. ".repeat(200) + "Second topic. ".repeat(200));
    const passages = memoryPassages(source);
    const { catalog } = fixture([]);
    vi.spyOn(catalog.get("hybrid"), "execute").mockResolvedValue({ request: { queries: ["topic"] },
      hits: [{ ...hit(source), passage: passages[0]! }] });
    vi.spyOn(catalog.get("lexical"), "execute").mockResolvedValue({ request: { queries: ["topic"] },
      hits: [{ ...hit(source), passage: passages.at(-1)! }] });
    const search = createSearchMemory({ operatorRegistry: catalog, scopeId: "scope" });
    const result = await search({ queries: ["topic"], branches: [{ operator: "lexical", queries: ["topic"] }] });
    expect(new Set(result.hits.map((item) => item.passage?.passageId)).size).toBe(2);
  });

  it("compares snapshots by their full timestamp and does not invent recency for undated values", () => {
    const result = buildAggregateOperatorResult([
      hit({ ...record("a-latest", "user", "Current total $20."), timestamp: "2024-01-01T20:00:00Z" }),
      hit({ ...record("z-earlier", "user", "Current total $10."), timestamp: "2024-01-02T01:00:00+08:00" }),
      hit(record("unknown", "user", "Current total $99.")),
    ]);
    expect(result.derived).toMatchObject({ latestCumulativeOrSnapshot: 20, latestMemoryId: "a-latest" });
    expect(extractNumericFacts("ambiguous -$-5")).toEqual([]);
    expect(extractNumericFacts("balance -$5, fee $-2").map((fact) => fact.value)).toEqual([-5, -2]);
  });

  it("uses the written local calendar day and includes the final fractional second", () => {
    expect(temporalAnnotation("2024-03-01T01:00:00+08:00", undefined)).toBe("weekday=Fri");
    const store = new MemoryStore(":memory:");
    try {
      store.ingestScope("scope", [{ ...record("late", "user", "departure"), timestamp: "2024-03-01T23:59:59.500Z" }]);
      const filter = explicitQueryDateFilter("departure on 2024-03-01")!;
      expect(store.search("scope", { queries: ["departure"], after: filter.after, before: filter.before })).toHaveLength(1);
    } finally { store.close(); }
  });

  it("honors the final session cap after structured index and seed results merge", async () => {
    const a = hit(record("a"));
    const b = hit(record("b"));
    const c = hit({ ...record("c"), sessionId: "other" });
    const catalog = createSearchOperatorRegistry({ search: () => [b, c], expandEvidenceOperator: () => [a] });
    const result = await catalog.get("numeric-index").execute({ scopeId: "scope" },
      { queries: ["topic"], limit: 2, maxPerSession: 1 });
    expect(result.hits.map((item) => item.record.memoryId)).toEqual(["a", "c"]);
  });
  it("keeps a lexical result prefix stable when only the visible limit changes", () => {
    const store = new MemoryStore(":memory:");
    try {
      store.ingestScope("scope", [
        ...Array.from({ length: 8 }, (_, index) => record(`red-${index}`, "user", "red fox")),
        record("blue", "user", "blue"),
      ]);
      const queries = ["red fox", "blue"];
      const shallow = store.search("scope", { queries, limit: 2 });
      const deep = store.search("scope", { queries, limit: 20 });
      expect(shallow.map((item) => item.record.memoryId)).toEqual(deep.slice(0, 2).map((item) => item.record.memoryId));
      expect(shallow.some((item) => item.record.memoryId === "blue")).toBe(true);
    } finally { store.close(); }
  });

  it("honors the configured default order even when a search call omits order", async () => {
    const { catalog } = fixture([
      { ...record("later"), timestamp: "2024-02-02T00:00:00Z" },
      { ...record("earlier"), timestamp: "2024-01-01T00:00:00Z" },
    ]);
    const search = createSearchMemory({ operatorRegistry: catalog, scopeId: "scope",
      searchDefaults: { order: "chronological", limit: 2 } });
    expect((await search({ queries: ["topic"] })).hits.map((item) => item.record.memoryId))
      .toEqual(["earlier", "later"]);
  });

  it("does not allow duplicate plugin hits to boost one branch's RRF vote", async () => {
    const { catalog } = fixture([record("a"), record("b")]);
    vi.spyOn(catalog.get("lexical"), "execute").mockResolvedValue({ request: { queries: ["topic"] },
      hits: [hit(record("b")), hit(record("b")), hit(record("b"))] });
    const output = await createSearchMemory({ operatorRegistry: catalog, scopeId: "scope" })({
      queries: ["topic"], branches: [{ operator: "lexical", queries: ["topic"] }],
    });
    expect(output.hits.find((item) => item.record.memoryId === "b")?.score)
      .toBeCloseTo(1 / 62 + 1 / 61);
  });

  it("does not claim full structured coverage or expose derived values after display truncation", () => {
    const hits = Array.from({ length: 20 }, (_, index) => hit(record(`n-${index}`, "user", `I earned $${index + 1}.`)));
    const ledger = new MemoryLedger("scope");
    ledger.recordSearchHits(hits);
    const result = buildAggregateOperatorResult(hits);
    result.derived = { latestCumulativeOrSnapshot: 20 };
    const rendered = renderEvidenceOperator(result, ledger);
    expect(rendered).toContain('"truncated":true');
    expect(rendered).not.toContain("derived=");
  });

  it("gives distinct numeric occurrences in one source distinct source-bound handles", () => {
    const hits = [hit(record("multi", "user", "I earned $10 and then $20."))];
    const ledger = new MemoryLedger("scope");
    ledger.recordSearchHits(hits);
    const rendered = renderEvidenceOperator(buildAggregateOperatorResult(hits), ledger);
    const refs = [...rendered.matchAll(/occurrence_ref=([^\s|]+)/gu)].map((match) => match[1]);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  it("applies the session cap before the numeric index candidate cutoff", () => {
    const store = new MemoryStore(":memory:");
    try {
      const sources = [record("a", "user", "sales $10"), record("b", "user", "sales $20"),
        { ...record("c", "user", "sales $30"), sessionId: "z-other-session" }];
      store.ingestScope("scope", sources);
      const results = store.expandEvidenceOperator("scope", { queries: ["sales"], maxPerSession: 1 },
        { operator: "numeric", maxCandidates: 2 }, sources.map((source, index) => hit(source, index + 1)));
      expect(new Set(results.map((item) => item.record.sessionId)).size).toBe(2);
    } finally { store.close(); }
  });

  it("does not claim every batched query matched each numeric index result", () => {
    const store = new MemoryStore(":memory:");
    try {
      store.ingestScope("scope", [record("flowers", "user", "flowers $10"),
        { ...record("bikes", "user", "bikes $20"), sessionId: "bikes" }]);
      const results = store.expandEvidenceOperator("scope", { queries: ["flowers", "bikes"] },
        { operator: "numeric", maxCandidates: 10 }, []);
      expect(results.find((item) => item.record.memoryId === "flowers")?.matchedQueries).toEqual(["flowers"]);
      expect(results.find((item) => item.record.memoryId === "bikes")?.matchedQueries).toEqual(["bikes"]);
    } finally { store.close(); }
  });
  it("does not push a branch's role/session restrictions into its shared source", async () => {
    const { catalog } = fixture([record("a"), record("b"), record("c", "assistant")]);
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid" },
      { id: "users", kind: "filter", input: "source", roles: ["user"] },
      { id: "spread", kind: "diversify", input: "users", by: "session", maxPerGroup: 1 },
      { id: "both", kind: "combine", inputs: ["source", "spread"], method: "union" },
    ]), 0).operator;
    const output = await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 10 });
    expect(output.hits.map((item) => item.record.memoryId)).toEqual(["a", "b", "c"]);
  });

  it("pushes a dominating role filter before the primitive top-k cutoff", async () => {
    const { catalog } = fixture([record("noise", "assistant"), record("answer")]);
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid" },
      { id: "users", kind: "filter", input: "source", roles: ["user"] },
    ]), 0).operator;
    expect((await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 1 }))
      .hits.map((item) => item.record.memoryId)).toEqual(["answer"]);
  });

  it("validates each primitive's scope before a later filter can hide the violation", async () => {
    const { catalog } = fixture([{ ...record("alien", "assistant"), scopeId: "other" }]);
    // This source ignores constraints, as a broken plugin might.
    const primitive = catalog.get("hybrid");
    vi.spyOn(primitive, "execute").mockResolvedValue({ request: { queries: ["topic"] },
      hits: [hit({ ...record("alien", "assistant"), scopeId: "other" })] });
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid" },
      { id: "users", kind: "filter", input: "source", roles: ["user"] },
    ]), 0).operator;
    await expect(plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 2 }))
      .rejects.toThrow();
  });

  it("retains structured fact provenance when fusing the same parent", async () => {
    const source = record("source");
    const catalog = createSearchOperatorRegistry({ search: () => [hit(source)] });
    vi.spyOn(catalog.get("lexical"), "execute").mockResolvedValue({
      request: { queries: ["topic"] }, hits: [{ ...hit(source),
        operatorSourceSpans: [{ start: 0, end: 6 }], operatorNumericFactIndexes: [0] }],
    });
    const search = createSearchMemory({ operatorRegistry: catalog, scopeId: "scope" });
    expect((await search({ queries: ["topic"], branches: [{ operator: "lexical", queries: ["topic"] }] }))
      .hits[0]).toMatchObject({ operatorSourceSpans: [{ start: 0, end: 6 }], operatorNumericFactIndexes: [0] });
  });

  it("keeps annotations through a subsequent sort and limits output to the caller's cap", async () => {
    const { catalog } = fixture([record("a", "user", "$10"), record("b", "user", "$20")]);
    const plan = buildDeclarativeSearchOperator(catalog, definition([
      { id: "source", kind: "search", operator: "hybrid", limit: 10 },
      { id: "numbers", kind: "annotate", input: "source", method: "numeric" },
      { id: "ordered", kind: "sort", input: "numbers", order: "chronological" },
    ]), 0).operator;
    const output = await plan.execute({ scopeId: "scope" }, { queries: ["topic"], limit: 1 });
    expect(output.hits).toHaveLength(1);
    expect(output.operatorResult?.rows.map((row) => row.memoryId)).toEqual(["a"]);
  });

  it("sorts by actual instants before truncation and puts unknown dates last in either direction", () => {
    const early = hit({ ...record("early"), timestamp: "2024-01-02T01:00:00+08:00" });
    const late = hit({ ...record("late"), timestamp: "2024-01-01T20:00:00Z" });
    const unknown = hit(record("unknown"));
    expect(finalizeSearchHits([early, unknown, late], { queries: ["topic"], order: "reverse-chronological" }, 1)
      .map((item) => item.record.memoryId)).toEqual(["late"]);
    expect(finalizeSearchHits([late, unknown, early], { queries: ["topic"], order: "chronological" }, 3)
      .map((item) => item.record.memoryId)).toEqual(["early", "late", "unknown"]);
  });

  it("accepts timezone-bearing timestamps and rejects invalid calendar dates", () => {
    expect(parseSourceTimestamp("2024-03-01T01:00:00.123+08:00")).toBe(Date.parse("2024-02-29T17:00:00.123Z"));
    expect(extractTemporalFacts("On 2024-02-31 and 2024-13-01.")).toEqual([]);
  });

  it("resolves explicit dates without a question timestamp and clamps calendar subtraction", () => {
    expect(resolveTemporalQuestion("What happened on 2024-02-29?").targets.map((target) => target.date))
      .toEqual(["2024-02-29"]);
    expect(resolveTemporalQuestion("What happened one month ago?", "2024-03-31T10:00:00").targets[0]?.date)
      .toBe("2024-02-29");
    expect(() => extractTemporalFacts("999999999999999999999 years ago", "2024-03-31T10:00:00"))
      .not.toThrow();
  });

  it("keeps quantity signs, local classification, and exact raw source spans", () => {
    const text = "I earned $10. My goal is $500. The balance is -5 dollars.";
    const facts = extractNumericFacts(text);
    expect(facts.map((fact) => fact.value)).toEqual([10, 500, -5]);
    expect(facts.map((fact) => fact.valueKind)).toEqual(["increment", "target", "increment"]);
    const sale = "I sold 20 potted plants for $7.5 each.";
    const saleFact = extractNumericFacts(sale)[0]!;
    expect(saleFact.value).toBe(150);
    expect(saleFact.raw).toBe(sale.slice(saleFact.index, saleFact.end));
    expect(extractNumericFacts("In 2024, tickets cost $7.5 each.")[0]?.value).toBe(7.5);
  });

  it("finds single-character identifiers and compares lexical time filters as instants", () => {
    const store = new MemoryStore(":memory:");
    try {
      store.ingestScope("scope", [record("one", "user", "Model X costs 7 dollars."),
        { ...record("time", "user", "departure"), timestamp: "2024-01-02T01:00:00+08:00" }]);
      expect(store.search("scope", { queries: ["X"] }).map((item) => item.record.memoryId)).toEqual(["one"]);
      expect(store.search("scope", { queries: ["departure"], before: "2024-01-01T18:00:00Z" })
        .map((item) => item.record.memoryId)).toEqual(["time"]);
      expect(store.search("scope", { queries: ["departure"], roles: [] })).toEqual([]);
    } finally { store.close(); }
  });
});
