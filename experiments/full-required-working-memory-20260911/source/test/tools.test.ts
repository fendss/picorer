import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  MemoryLedger,
  projectMemoryEvidence,
} from "../src/evidence-agent/index.js";
import type { StoreSearchHit } from "../src/platform/sqlite/picorer-store.js";
import {
  createFinishOnlyBeforeToolCall,
  createToolProtocolBeforeToolCall,
  DefineOperatorParameters,
  createPicorerTools as createPicorerToolsWithRegistry,
  validateFinishToolBatch,
  type CreatePicorerToolsOptions,
  type MemoryToolStore,
} from "../src/evidence-agent/adapters/pi/tools.js";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import type { MemoryRecord } from "../src/memory/index.js";
import type { SearchRequest } from "../src/retrieval/index.js";

function record(memoryId: string, turnIndex: number): MemoryRecord {
  return {
    memoryId,
    scopeId: "scope-1",
    sessionId: "session-1",
    turnIndex,
    role: turnIndex % 2 === 0 ? "user" : "assistant",
    content: `source ${memoryId}`,
    contentHash: `hash-${memoryId}`,
    metadata: {},
  };
}

function createStore(
  searched: MemoryRecord,
  expanded: MemoryRecord,
): MemoryToolStore {
  return {
    search(_scopeId: string, request: SearchRequest): StoreSearchHit[] {
      return [
        {
          record: searched,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: searched.content,
        },
      ];
    },
    read(): MemoryRecord[] {
      return [searched, expanded];
    },
  };
}

function createPicorerTools(
  options: Omit<CreatePicorerToolsOptions, "operatorRegistry">,
) {
  return createPicorerToolsWithRegistry({
    ...options,
    operatorRegistry: createSearchOperatorRegistry(options.store),
  });
}

describe("Picorer tools", () => {
  it("collects structured search and inspect candidates, including expansion", async () => {
    const searched = record("m1", 0);
    const expanded = record("m2", 1);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, expanded),
      scopeId: "scope-1",
      ledger,
      maxSearchCalls: 4,
    });
    const searchSchema = JSON.stringify(tools.search.parameters);
    expect(searchSchema).toContain(
      "Each query must add a distinct evidence-frame signal",
    );
    expect(searchSchema).toContain(
      "sixteen is a hard ceiling, not a target",
    );
    expect(searchSchema).toContain(
      "Optional additional retrieval paths executed in this same search call",
    );
    expect(searchSchema).not.toContain('"roles"');
    expect(searchSchema).toContain('"additionalProperties":false');
    const defineOperatorSchema = JSON.stringify(DefineOperatorParameters);
    expect(defineOperatorSchema).not.toContain('"filter"');
    expect(defineOperatorSchema).not.toContain('"roles"');
    expect(searchSchema).toContain(
      "this does not change the hidden physical reservoir",
    );

    const searchResult = await tools.search.execute("search-1", {
      queries: [" source ", "source"],
      limit: 10,
    });
    expect(searchResult.details.kind).toBe("search");
    expect(searchResult.details.request).toMatchObject({
      queries: ["source"],
      limit: 10,
      order: "relevance",
    });
    expect(searchResult.details.candidates).toEqual([
      expect.objectContaining({
        memoryId: "m1",
        inspected: false,
        committed: false,
      }),
    ]);
    const searchObservation = JSON.stringify(searchResult.content);
    expect(searchObservation).toContain("<MEMORY>");
    expect(searchObservation).toContain("Searches remaining: 3");
    expect(searchObservation).toContain("Latest uninspected findings");
    expect(searchObservation).toContain(
      "Uninspected finding: 1 across 1 separate conversation.",
    );
    expect(searchObservation).toContain("source m1");
    expect(searchObservation).toContain("read C1");
    expect(searchObservation).not.toContain("candidate_refs");
    expect(searchObservation).not.toContain("matched_query");

    const inspectResult = await tools.read.execute("read-1", {
      candidateRefs: ["C1"],
    });
    expect(inspectResult.details.kind).toBe("read");
    expect(inspectResult.details.contextBefore).toBe(1);
    expect(inspectResult.details.contextAfter).toBe(1);
    expect(inspectResult.details.expandedMemoryIds).toEqual(["m2"]);
    expect(inspectResult.details.candidates.map((item) => item.memoryId)).toEqual([
      "m1",
      "m2",
    ]);
    expect(ledger.inspectedEvidence.map((item) => item.memoryId)).toEqual(["m1", "m2"]);
    expect(
      ledger.candidates.find((item) => item.memoryId === "m2")?.discoveries,
    ).toEqual([expect.objectContaining({ tool: "read_expansion" })]);
    const inspectObservation = JSON.stringify(inspectResult.content);
    expect(inspectObservation).toContain("Searches remaining: 3");
    expect(inspectObservation).toContain("<READ_RESULT>");
    expect(inspectObservation).toContain("Inspected evidence ledger");
    expect(inspectObservation).toContain("source m1");
    expect(inspectObservation).toContain("source m2");
    expect(inspectObservation).toContain("evidence E1");
    expect(inspectObservation).toContain("evidence E2");
    expect(inspectObservation).toContain("inspected from C1");
    expect(inspectObservation).toContain("inspected from C2");
    expect(inspectObservation).toContain("No earlier uninspected findings");

    const finishResult = await tools.finish.execute("finish-1", {
      status: "sufficient",
      evidenceSummary: "The source and its neighboring turn provide the requested fact.",
    });
    expect(finishResult.terminate).toBe(true);
    expect(
      finishResult.details.selection.citations.map((item) => item.memoryId),
    ).toEqual(["m1", "m2"]);
    expect(finishResult.details.committedEvidenceRefs).toEqual(["E1", "E2"]);
    expect(finishResult.details.committedEvidence).toEqual([
      expect.objectContaining({
        memoryId: "m1",
        contentHash: expect.any(String),
        sourceContentHash: "hash-m1",
      }),
      expect.objectContaining({
        memoryId: "m2",
        contentHash: expect.any(String),
        sourceContentHash: "hash-m2",
      }),
    ]);
    expect(finishResult.details.selection.evidenceSummary).toBe(
      "The source and its neighboring turn provide the requested fact.",
    );
    expect(ledger.selection?.status).toBe("sufficient");
  });

  it("keeps oversized source payloads out of structured inspect audit details", async () => {
    const searched = {
      ...record("m-large", 0),
      content:
        `Step 5:\n${"private-payload ".repeat(40_000)}` +
        "World Bank indicator completed successfully.",
    };
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return [{
          record: searched,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: "World Bank indicator result",
        }];
      },
      read() {
        return [searched];
      },
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      question: "When did the World Bank indicator complete successfully?",
    });
    await tools.search.execute("search-large", {
      queries: ["World Bank indicator completed successfully"],
    });

    const result = await tools.read.execute("read-large", { candidateRefs: ["C1"] });

    expect(result.details.evidence[0]).toMatchObject({
      memoryId: "m-large",
      truncated: true,
      sourceContentLength: searched.content.length,
    });
    expect(JSON.stringify(result.details).length).toBeLessThan(2_500);
    expect(JSON.stringify(result.content).length).toBeLessThan(10_000);
  });

  it("keeps chronological retrieval primitive and applies its ordering", async () => {
    const searched = {
      ...record("m-time", 0),
      timestamp: "2024-01-01T00:00:00",
    };
    let observed: SearchRequest | undefined;
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        observed = request;
        return [{
          record: searched,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: searched.content,
        }];
      },
      read() {
        return [searched];
      },
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      questionDate: "2024/01/03 (Wed) 00:00",
    });

    const result = await tools.search.execute("search-time", {
      operator: "chronological",
      queries: ["source"],
    });

    expect(observed).toEqual({
      queries: ["source"],
      limit: 80,
      order: "chronological",
    });
    expect(result.details.request.limit).toBe(20);
    expect(JSON.stringify(result.content)).toContain(
      "2 days before question",
    );
  });

  it("composes retrieval branches and result-shape modifiers inside one search call", async () => {
    const semantic = {
      ...record("m-semantic", 0),
      sessionId: "session-new",
      timestamp: "2024-02-01T00:00:00",
      content: "The user described the newer state.",
    };
    const exact = {
      ...record("m-exact", 0),
      sessionId: "session-old",
      timestamp: "2024-01-01T00:00:00",
      content: "The user stated the earlier exact value.",
    };
    const assistant = {
      ...record("m-assistant", 1),
      sessionId: "session-assistant",
      timestamp: "2023-12-01T00:00:00",
      content: "An assistant-only suggestion.",
    };
    const requests: SearchRequest[] = [];
    const hits = (
      request: SearchRequest,
      memories: MemoryRecord[],
      retriever: StoreSearchHit["retriever"],
    ): StoreSearchHit[] => {
      requests.push(request);
      const roles = request.roles === undefined
        ? undefined
        : new Set(request.roles);
      return memories
        .filter((memory) => roles === undefined || roles.has(memory.role))
        .map((memory, index) => ({
          record: memory,
          query: request.queries[0] ?? "",
          retriever,
          rank: index + 1,
          score: 1 / (index + 1),
          preview: memory.content,
        }));
    };
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return hits(request, [semantic, assistant], "picorer-hybrid");
      },
      searchLexical(_scopeId, request) {
        return hits(request, [exact, assistant], "fts5");
      },
      read: () => [],
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const result = await tools.search.execute("search-inline", {
      operator: "hybrid",
      queries: Array.from(
        { length: 14 },
        (_, index) => `state evidence path ${String(index + 1)}`,
      ),
      branches: [{
        operator: "lexical",
        queries: ["earlier exact value"],
      }],
      combine: "union",
      order: "chronological",
      maxPerSession: 1,
      // Simulate a transport that skips schema validation and forwards a stale
      // model-generated field. The execution boundary must still discard it.
      roles: ["user"],
    } as never);

    expect(requests).toHaveLength(2);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ maxPerSession: 1 }),
    ]));
    expect(requests.every((request) => request.roles === undefined)).toBe(true);
    expect(result.details.candidates.map((candidate) => candidate.memoryId)).toEqual([
      "m-assistant",
      "m-exact",
      "m-semantic",
    ]);
    expect(result.details.request).toMatchObject({
      order: "chronological",
      maxPerSession: 1,
    });
    expect(result.details.request.roles).toBeUndefined();
    expect(result.details.composition?.steps.map((step) => step.kind)).toEqual([
      "search",
      "search",
      "combine",
      "sort",
      "diversify",
    ]);
    expect(JSON.stringify(result.content)).toContain("Fuse with union");
  });

  it("treats a combine hint without branches as an ordinary search", async () => {
    const searched = record("m-single-path", 0);
    const tools = createPicorerTools({
      store: createStore(searched, record("m-single-path-neighbor", 1)),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const result = await tools.search.execute("search-single-path", {
      operator: "hybrid",
      queries: ["single evidence path"],
      combine: "rrf",
    });

    expect(result.details.operator).toBe("hybrid");
    expect(result.details.composition).toBeUndefined();
    expect(result.details.candidates).toHaveLength(1);
  });

  it("applies a per-session cap only when the caller configures one", async () => {
    const searched = record("m-capped", 0);
    let observed: SearchRequest | undefined;
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        observed = request;
        return [{
          record: searched,
          query: request.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: searched.content,
        }];
      },
      read() {
        return [searched];
      },
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      searchDefaults: { limit: 20, order: "relevance", maxPerSession: 4 },
    });

    await tools.search.execute("search-capped", { queries: ["source"] });

    expect(observed).toMatchObject({ maxPerSession: 4 });
  });

  it("awaits asynchronous retrieval without changing the search schema", async () => {
    const searched = record("m-async", 0);
    let observedSignal: AbortSignal | undefined;
    const store: MemoryToolStore = {
      async search(_scopeId, request, signal) {
        observedSignal = signal;
        await Promise.resolve();
        return [{
          record: searched,
          query: request.queries[0] ?? "",
          retriever: "picorer-hybrid",
          rank: 1,
          score: 1 / 61 + 1 / 61,
          preview: searched.content,
        }];
      },
      read() {
        return [searched];
      },
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });
    const controller = new AbortController();

    const result = await tools.search.execute(
      "search-async",
      { queries: ["source"] },
      controller.signal,
    );

    expect(result.details.candidates[0]).toMatchObject({ memoryId: "m-async" });
    expect(observedSignal).toBe(controller.signal);
  });

  it("finishes insufficient without promoting unread search previews", async () => {
    const searched = record("m1", 0);
    const expanded = record("m2", 1);
    const ledger = new MemoryLedger("scope-1");
    let storeReadCalls = 0;
    const store = createStore(searched, expanded);
    const tools = createPicorerTools({
      store: {
        ...store,
        read(...args) {
          storeReadCalls += 1;
          return store.read(...args);
        },
      },
      scopeId: "scope-1",
      ledger,
    });

    await tools.search.execute("search-1", { queries: ["source"] });
    const result = await tools.finish.execute("finish-1", {
      status: "insufficient",
      evidenceSummary: "No exact source evidence was inspected.",
    });

    expect(storeReadCalls).toBe(0);
    expect(ledger.inspectedEvidence).toEqual([]);
    expect(result.details.selection).toEqual({
      status: "insufficient",
      citations: [],
      evidenceSummary: "No exact source evidence was inspected.",
    });
  });

  it("requires only status and permits an optional audit summary", async () => {
    const searched = record("m1", 0);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, record("m2", 1)),
      scopeId: "scope-1",
      ledger,
    });

    const schema = tools.finish.parameters as unknown as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const rendered = JSON.stringify(schema);
    expect(rendered).toContain("Stop retrieval");
    expect(schema.required).toEqual(["status"]);
    expect(Object.keys(schema.properties)).toEqual([
      "status",
      "evidenceSummary",
    ]);
    expect(ledger.selection).toBeUndefined();
  });

  it("does not promote a partial inspect to sufficient coverage", async () => {
    const searched = record("m-partial", 0);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger,
    });
    await tools.search.execute("search-partial", { queries: ["partial fact"] });
    await tools.read.execute("read-partial", { candidateRefs: ["C1"] });

    const result = await tools.finish.execute("finish-partial", {
      status: "insufficient",
      evidenceSummary: "The inspected source covers one fact, but another required slot remains unsupported.",
    });

    expect(result.details.selection.status).toBe("insufficient");
    expect(result.details.selection.citations).toHaveLength(2);
    expect(result.details.committedEvidenceRefs).toEqual(["E1", "E2"]);
    expect(ledger.inspectedEvidence).toHaveLength(2);
    expect(ledger.candidates.find((candidate) => candidate.memoryId === "m-partial"))
      .toMatchObject({ inspected: true, committed: true });
    expect(ledger.candidates.find((candidate) => candidate.memoryId === "m-neighbor"))
      .toMatchObject({ inspected: true, committed: true });
  });

  it("lets an operator block finish before the ledger accepts it", async () => {
    const searched = record("m1", 0);
    const expanded = record("m2", 1);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, expanded),
      scopeId: "scope-1",
      ledger,
      beforeFinish: () => {
        throw new Error("run evidence exhaustion");
      },
    });
    await tools.search.execute("search-1", { queries: ["source"] });
    await tools.read.execute("read-1", { candidateRefs: ["C1"] });

    await expect(
      tools.finish.execute("finish-1", {
        status: "sufficient",
        evidenceSummary: "The inspected source provides the requested fact.",
      }),
    ).rejects.toThrow(/evidence exhaustion/u);
    expect(ledger.selection).toBeUndefined();
  });

  it("leaves count and inventory reasoning to the downstream answer model", async () => {
    const searched = record("m-count", 0);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger,
    });
    await tools.search.execute("search-count", { queries: ["restaurants"] });
    await tools.read.execute("read-count", { candidateRefs: ["C1"] });

    const result = await tools.finish.execute("finish-count", {
      status: "sufficient",
      evidenceSummary: "The committed sources contain the restaurant evidence.",
    });

    expect(result.details.selection.count).toBeUndefined();
    expect(result.details.selection.inventory).toBeUndefined();
    expect(result.details.selection.citations).toHaveLength(2);
  });

  it("cites each exact source once and preserves the semantic handoff", async () => {
    const searched = {
      ...record("m-list", 0),
      content: "The supported languages are Ruby, Python, and PHP.",
    };
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger,
    });
    await tools.search.execute("search-list", { queries: ["supported languages"] });
    await tools.read.execute("read-list", { candidateRefs: ["C1"] });

    const result = await tools.finish.execute("finish-list", {
      status: "sufficient",
      evidenceSummary: "The supported languages are Ruby, Python, and PHP.",
    });

    expect(result.details.selection.citations).toEqual([
      {
        memoryId: "m-list",
        supports: "The supported languages are Ruby, Python, and PHP.",
      },
      {
        memoryId: "m-neighbor",
        supports: "source m-neighbor",
      },
    ]);
    expect(result.details.selection.evidenceSummary).toBe(
      "The supported languages are Ruby, Python, and PHP.",
    );
  });

  it("automatically commits the complete read ledger beyond the former selection limit", async () => {
    const ledger = new MemoryLedger("scope-1");
    const admitted = Array.from(
      { length: 33 },
      (_, index) => ({
        ...record(`m-cap-${String(index)}`, index),
        content: "x".repeat(8_192),
      }),
    );
    ledger.recordInspect(admitted.map((source) =>
      projectMemoryEvidence(source, [], 8_192)
    ));
    expect(ledger.inspectedEvidence).toHaveLength(33);

    const tools = createPicorerTools({
      store: createStore(record("m-unused", 0), record("m-unused-2", 1)),
      scopeId: "scope-1",
      ledger,
    });
    const result = await tools.finish.execute("finish-at-capacity", {
      status: "sufficient",
      evidenceSummary: "The committed evidence set covers the question.",
    });

    expect(result.terminate).toBe(true);
    expect(result.details.selection.citations).toHaveLength(33);
    expect(result.details.committedEvidenceRefs).toEqual(
      Array.from({ length: 33 }, (_, index) => `E${String(index + 1)}`),
    );
    expect(ledger.inspectedEvidence).toHaveLength(33);
  });

  it("documents harness-owned finish and opaque candidate handles", () => {
    const tools = createPicorerTools({
      store: createStore(record("m1", 0), record("m2", 1)),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    expect(tools.finish.description).toContain("harness generates citations");
    expect(tools.finish.description).toContain("every exact source returned by read");
    expect(JSON.stringify(tools.read.parameters)).toContain(
      "^C[1-9][0-9]*$",
    );
    expect(JSON.stringify(tools.finish.parameters)).not.toContain("evidenceRefs");
    expect(tools.all.map((tool) => tool.name)).toContain("read");
    expect(tools.all.map((tool) => tool.name)).not.toContain("inspect");
  });

  it("allows multiple query variants while keeping physical depth private", async () => {
    const searched = record("m-flexible", 0);
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const first = await tools.search.execute("search-1", {
      queries: ["first entity", "second related entity"],
      limit: 40,
    });
    expect(first.details.request).toMatchObject({
      queries: ["first entity", "second related entity"],
      limit: 20,
    });
    expect(first.details.physicalPlan?.candidateReservoirLimit).toBe(80);
    await tools.search.execute("search-2", { queries: ["missing date"] });
    await tools.search.execute("search-3", { queries: ["state before update"] });
    await expect(
      tools.search.execute("search-4", { queries: ["exact hard negative"] }),
    ).resolves.toMatchObject({ details: { kind: "search" } });
  });

  it("preserves matched query provenance for coverage, receipts, and inspect focus", async () => {
    const searched = {
      ...record("m-multi-query", 0),
      content: [
        "head ",
        "x".repeat(5_000),
        " alphaMarker supports the first evidence frame. ",
        "y".repeat(9_000),
        " betaMarker supports the second evidence frame. ",
        "z".repeat(5_000),
      ].join(""),
    };
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return [{
          record: searched,
          query: `database numeric facts for ${request.queries.join(" | ")}`,
          matchedQueries: [...request.queries],
          retriever: "picorer-aggregate-db",
          rank: 1,
          score: 1,
          preview: "A bounded candidate preview.",
        }];
      },
      read() {
        return [searched];
      },
    };
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger,
    });

    const search = await tools.search.execute("search-multi-query", {
      queries: ["alphaMarker", "betaMarker"],
    });
    expect(search.details.coverageProgress.queries).toEqual([
      expect.objectContaining({
        query: "alphaMarker",
        returnedCandidateCount: 1,
      }),
      expect.objectContaining({
        query: "betaMarker",
        returnedCandidateCount: 1,
      }),
    ]);
    expect(ledger.candidates).toHaveLength(1);
    expect(ledger.candidates.map((candidate) =>
      candidate.discoveries.map((item) => item.query)
    )).toEqual([["alphaMarker", "betaMarker"]]);

    const inspected = await tools.read.execute("read-multi-query", {
      candidateRefs: ["C1"],
    });
    const rendered = JSON.stringify(inspected.content);
    expect(rendered).toContain("alphaMarker supports the first evidence frame");
    expect(rendered).toContain("betaMarker supports the second evidence frame");
    expect(rendered).toContain("evidence:E1");
    expect(rendered).not.toContain("database numeric facts");
  });

  it("audits punctuation-only query repeats without rejecting them", async () => {
    const searched = record("m-repeat", 0);
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const first = await tools.search.execute("search-1", {
      queries: ["pages left in The Nightingale?"],
    });
    expect(first.details.repeatedQueries).toBeUndefined();

    const repeated = await tools.search.execute("search-repeat", {
      queries: ["Pages left in The Nightingale."],
    });
    expect(repeated.details.repeatedQueries).toEqual([
      "Pages left in The Nightingale.",
    ]);
  });

  it("uses the Agent-selected temporal index without task-level routing", async () => {
    const generic = {
      ...record("m-generic", 0),
      timestamp: "2023-03-10T10:00:00",
      content: "I bought a portable power bank.",
    };
    const target = {
      ...record("m-target", 0),
      sessionId: "session-target",
      timestamp: "2023-03-15T10:00:00",
      content: "I bought a smoker for the kitchen.",
    };
    const requests: SearchRequest[] = [];
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        requests.push(request);
        return [{
          record: generic,
          query: request.queries[0] ?? "",
          retriever: "picorer-hybrid",
          rank: 1,
          score: 1,
          preview: generic.content,
        }];
      },
      expandEvidenceOperator(_scopeId, request) {
        return [{
          record: target,
          query: request.queries[0] ?? "",
          retriever: "picorer-timeline-db",
          rank: 1,
          score: 1,
          preview: target.content,
        }];
      },
      read(_scopeId, memoryIds) {
        return [generic, target].filter((item) => memoryIds.includes(item.memoryId));
      },
    };
    const tools = createPicorerTools({
      store,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      question: "What kitchen appliance did I buy 10 days ago?",
      questionDate: "2023/03/25 (Sat) 18:26",
      searchDefaults: { limit: 20, order: "relevance", maxPerSession: 4 },
    });

    const result = await tools.search.execute("search-temporal", {
      operator: "temporal-index",
      queries: ["kitchen appliance purchase"],
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      after: "2023-03-15T00:00:00",
      before: "2023-03-15T23:59:59.999",
      order: "chronological",
    });
    expect(result.details.operator).toBe("temporal-index");
    expect(result.details.candidates[0]?.memoryId).toBe("m-target");
    expect(JSON.stringify(result.content)).not.toContain("Temporal evidence");
    expect(JSON.stringify(result.content)).toContain("read C1");
  });

  it("keeps opaque memory IDs inside the harness and validates simple refs", async () => {
    const searched = {
      ...record("m-dd73e626e75c3cab75a9578f", 0),
      content: "source text without an internal identifier",
    };
    const tools = createPicorerTools({
      store: createStore(searched, record("m-neighbor", 1)),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });
    const search = await tools.search.execute("search-1", { queries: ["source"] });

    expect(JSON.stringify(search.content)).not.toContain(searched.memoryId);
    expect(search.details.candidateReferences).toEqual([
      { candidateRef: "C1", memoryId: searched.memoryId },
    ]);
    expect(JSON.stringify(tools.read.parameters)).not.toContain(
      '"items":{"type":"integer"',
    );
    await expect(
      tools.read.execute("read-bad", { candidateRefs: ["C99"] }),
    ).rejects.toThrow(/Valid candidate range is C1-C1/u);
  });

  it("automatically commits every read source without refs or an evidence summary", async () => {
    const searched = record("m-auto-commit", 0);
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: createStore(searched, record("m-unselected-neighbor", 1)),
      scopeId: "scope-1",
      ledger,
    });
    await tools.search.execute("search-auto-commit", {
      queries: ["automatic commit"],
    });
    await tools.read.execute("read-auto-commit", {
      candidateRefs: ["C1"],
    });

    const result = await tools.finish.execute("finish-auto-commit", {
      status: "sufficient",
    });
    expect(result.details.selection).not.toHaveProperty("evidenceSummary");
    expect(result.details.committedEvidenceRefs).toEqual(["E1", "E2"]);
    expect(ledger.selection?.citations.map((citation) => citation.memoryId)).toEqual([
      "m-auto-commit",
      "m-unselected-neighbor",
    ]);
    expect(ledger.candidates.every((candidate) => candidate.committed)).toBe(true);
  });

  it("requires finish to be the only tool call in its assistant turn", async () => {
    expect(validateFinishToolBatch(["finish"])).toBeUndefined();
    expect(validateFinishToolBatch(["search"])).toBeUndefined();
    expect(validateFinishToolBatch(["search", "finish"])).toMatch(/only tool call/u);
    expect(validateFinishToolBatch(["read", "finish"])).toMatch(/only tool call/u);
    expect(validateFinishToolBatch(["finish", "search"])).toMatch(/only tool call/u);
    expect(validateFinishToolBatch(["finish", "finish"])).toMatch(/only tool call/u);

    const hook = createFinishOnlyBeforeToolCall();
    const mixedContext = {
      assistantMessage: {
        content: [
          { type: "toolCall", id: "1", name: "search", arguments: {} },
          { type: "toolCall", id: "2", name: "finish", arguments: {} },
        ],
      },
      toolCall: { type: "toolCall", id: "1", name: "search", arguments: {} },
      args: {},
      context: { systemPrompt: "", messages: [], tools: [] },
    } as unknown as BeforeToolCallContext;

    await expect(hook(mixedContext)).resolves.toBeUndefined();

    const searchFinishContext = {
      ...mixedContext,
      toolCall: { type: "toolCall", id: "2", name: "finish", arguments: {} },
    } as unknown as BeforeToolCallContext;
    await expect(hook(searchFinishContext)).resolves.toEqual({
      block: true,
      reason:
        "finish must be the only tool call in its assistant turn; observe this turn's tool results before finishing in a later turn",
    });

    const prematureFinishContext = {
      ...mixedContext,
      assistantMessage: {
        content: [
          { type: "toolCall", id: "1", name: "read", arguments: {} },
          { type: "toolCall", id: "2", name: "finish", arguments: {} },
        ],
      },
      toolCall: { type: "toolCall", id: "2", name: "finish", arguments: {} },
    } as unknown as BeforeToolCallContext;
    await expect(hook(prematureFinishContext)).resolves.toEqual({
      block: true,
      reason:
        "finish must be the only tool call in its assistant turn; observe this turn's tool results before finishing in a later turn",
    });

    const unsafeContext = {
      ...mixedContext,
      assistantMessage: {
        content: [
          { type: "toolCall", id: "2", name: "finish", arguments: {} },
          { type: "toolCall", id: "1", name: "search", arguments: {} },
        ],
      },
      toolCall: { type: "toolCall", id: "2", name: "finish", arguments: {} },
    } as unknown as BeforeToolCallContext;
    await expect(hook(unsafeContext)).resolves.toEqual({
      block: true,
      reason:
        "finish must be the only tool call in its assistant turn; observe this turn's tool results before finishing in a later turn",
    });
  });

  it("enforces the search budget at actual execution time", async () => {
    const searched = record("m-budget", 0);
    let executions = 0;
    const store = createStore(searched, record("m-expanded", 1));
    const countedStore: MemoryToolStore = {
      ...store,
      search(scopeId, request, signal) {
        executions += 1;
        return store.search(scopeId, request, signal);
      },
    };
    const tools = createPicorerTools({
      store: countedStore,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      maxSearchCalls: 2,
    });

    await tools.search.execute("search-1", { queries: ["first"] });
    await tools.search.execute("search-2", { queries: ["second"] });
    await expect(
      tools.search.execute("search-3", { queries: ["third"] }),
    ).rejects.toThrow(
      "Search budget exhausted after 2 calls. Use existing candidates, read only useful sources, and call finish.",
    );
    expect(executions).toBe(2);
  });
});
