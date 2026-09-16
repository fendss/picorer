import { sha256 } from "../src/util.js";
import { PASSAGE_VIEW_VERSION } from "../src/retrieval/model/passage.js";
import { describe, expect, it } from "vitest";
import {
  createPicorerTools,
  MemoryLedger,
} from "../src/evidence-agent/index.js";
import type { MemoryRecord } from "../src/memory/index.js";
import { finalizeSearchHits } from "../src/retrieval/finalize-search-hits.js";
import {
  SearchOperatorRegistry,
  type RetrievalHit,
  type SearchOperator,
} from "../src/retrieval/index.js";

function memory(
  memoryId: string,
  sessionId: string,
  turnIndex: number,
): MemoryRecord {
  return {
    memoryId,
    scopeId: "scope-1",
    sessionId,
    turnIndex,
    role: "user",
    content: `${memoryId} source text`,
    contentHash: `${memoryId}-hash`,
    metadata: {},
  };
}

function hit(record: MemoryRecord, query: string, rank: number): RetrievalHit {
  return {
    record,
    query,
    matchedQueries: [query],
    retriever: "picorer-hybrid",
    rank,
    score: 1 / rank,
    preview: record.content,
  };
}

describe("search coverage progress", () => {
  it("reports candidate and session novelty without claiming global recall", async () => {
    const first = memory("first", "session-a", 0);
    const repeated = memory("repeated", "session-b", 0);
    const sameSessionDepth = memory("same-session-depth", "session-b", 1);
    let call = 0;
    const operator: SearchOperator = {
      id: "test-frontier",
      version: "1",
      guide: {
        summary: "Test a bounded frontier.",
        useWhen: ["Testing."],
        cost: "low",
      },
      execute(_context, input) {
        call += 1;
        const query = input.queries[0]!;
        const records = call === 1
          ? [first, repeated]
          : [repeated, sameSessionDepth];
        return Promise.resolve({
          request: {
            queries: [...input.queries],
            limit: input.limit,
            order: "relevance",
          },
          hits: records.map((record, index) => hit(record, query, index + 1)),
        });
      },
    };
    const registry = new SearchOperatorRegistry("test-frontier")
      .register(operator)
      .freeze();
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: registry,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const initial = await tools.search.execute("initial", {
      queries: ["film festival attendance"],
      limit: 2,
    });
    expect(initial.details.coverageProgress).toMatchObject({
      call: 1,
      status: "new-sessions",
      requestedLimit: 80,
      reachedRequestedLimit: false,
      returnedCandidateCount: 2,
      returnedSessionCount: 2,
      newCandidateCount: 2,
      repeatedCandidateCount: 0,
      newSessionCount: 2,
      repeatedSessionCount: 0,
      consecutiveNoNewCandidateCalls: 0,
    });

    const depth = await tools.search.execute("depth", {
      queries: ["another festival event"],
      limit: 2,
    });
    expect(depth.details.coverageProgress).toMatchObject({
      call: 2,
      status: "known-session-depth",
      newCandidateCount: 1,
      repeatedCandidateCount: 1,
      newSessionCount: 0,
      repeatedSessionCount: 1,
      consecutiveNoNewCandidateCalls: 0,
      consecutiveNoNewSessionCalls: 1,
    });

    const saturated = await tools.search.execute("saturated", {
      queries: ["Another festival event!"],
      limit: 2,
    });
    expect(saturated.details.repeatedQueries).toEqual([
      "Another festival event!",
    ]);
    expect(saturated.details.coverageProgress).toMatchObject({
      call: 3,
      status: "no-new-candidates",
      newCandidateCount: 0,
      repeatedCandidateCount: 2,
      newQueryCount: 0,
      repeatedQueryCount: 1,
      consecutiveNoNewCandidateCalls: 1,
      consecutiveNoNewSessionCalls: 2,
    });
    expect(JSON.stringify(saturated.content)).toMatch(
      /(?:not|never) proof|global completeness/iu,
    );
    expect(JSON.stringify(saturated.content)).toContain(
      'Query paths yielding no new candidates: \\"Another festival event!\\" (repeated)',
    );
  });

  it("keeps the initial page unchanged and reveals hidden parent candidates on demand", async () => {
    const records = Array.from({ length: 80 }, (_, index) =>
      memory(
        `m-${String(index + 1).padStart(2, "0")}`,
        `session-${String(index + 1).padStart(2, "0")}`,
        0,
      )
    );
    records[79] = {
      ...records[79]!,
      content:
        `${"unrelated prefix ".repeat(80)}` +
        "stable parent query DIRECTORY_TARGET " +
        `${"unrelated suffix ".repeat(80)}HIDDEN_DIRECTORY_TAIL`,
    };
    const requestedLimits: number[] = [];
    const operator: SearchOperator = {
      id: "paged",
      version: "1",
      guide: {
        summary: "Return one stable parent ranking.",
        useWhen: ["Testing continuation."],
        cost: "low",
      },
      execute(_context, input) {
        requestedLimits.push(input.limit);
        return Promise.resolve({
          request: {
            queries: [...input.queries],
            limit: input.limit,
            order: "relevance",
          },
          hits: records.slice(0, input.limit).map((record, index) =>
            hit(record, input.queries[0]!, index + 1)
          ),
        });
      },
    };
    const registry = new SearchOperatorRegistry("paged")
      .register(operator)
      .freeze();
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: {
        search: () => [],
        read: (_scopeId, memoryIds) => records.filter((record) =>
          memoryIds.includes(record.memoryId)
        ),
      },
      operatorRegistry: registry,
      scopeId: "scope-1",
      ledger,
      maxSearchCalls: 1,
    });

    expect(tools.all.map((tool) => tool.name)).toContain("search_more");
    await expect(tools.searchMore.execute("too-early", {})).rejects.toThrow(
      /no continuation page/iu,
    );

    const initial = await tools.search.execute("initial-page", {
      queries: ["stable parent query"],
      limit: 6,
    });
    expect(initial.details.candidates.map((item) => item.memoryId)).toEqual(
      records.slice(0, 6).map((record) => record.memoryId),
    );
    expect(initial.details.pagination).toEqual({
      mode: "initial",
      page: 1,
      depth: 6,
      hasMore: true,
      directoryCandidateCount: 74,
      presentationOnly: false,
    });
    expect(initial.details.physicalPlan).toEqual({
      candidateReservoirLimit: 80,
      candidateReservoirCount: 80,
      exhausted: false,
    });
    expect(ledger.candidates.map((item) => item.memoryId)).toEqual(
      records.map((record) => record.memoryId),
    );
    expect(initial.details.directoryCandidateReferences).toHaveLength(74);
    expect(initial.details.coverageProgress).toMatchObject({
      call: 1,
      requestedLimit: 80,
      returnedCandidateCount: 80,
      reachedRequestedLimit: true,
    });
    expect(JSON.stringify(initial.content)).toContain(
      "Additional candidates from the same search",
    );
    expect(JSON.stringify(initial.content)).toContain("read C7");
    expect(JSON.stringify(initial.content)).toContain("read C80");
    expect(JSON.stringify(initial.content)).toContain("DIRECTORY_TARGET");
    expect(JSON.stringify(initial.content)).not.toContain(
      "HIDDEN_DIRECTORY_TAIL",
    );

    const directoryRead = await tools.read.execute("read-directory", {
      candidateRefs: ["C80"],
    });
    expect(JSON.stringify(directoryRead.content)).toContain("DIRECTORY_TARGET");
    expect(JSON.stringify(directoryRead.content)).toContain(
      "HIDDEN_DIRECTORY_TAIL",
    );

    const top20 = await tools.searchMore.execute("top-20", {
      workingMemory: "The first page is incomplete; inspect the same ranking.",
    });
    expect(top20.details.candidates.map((item) => item.memoryId)).toEqual(
      records.slice(6, 20).map((record) => record.memoryId),
    );
    expect(top20.details.pagination).toEqual({
      mode: "continuation",
      page: 2,
      depth: 20,
      hasMore: true,
      directoryCandidateCount: 60,
      presentationOnly: true,
    });
    expect(top20.details.coverageProgress).toEqual(
      initial.details.coverageProgress,
    );
    expect(JSON.stringify(top20.content)).toContain("Searches remaining: 0");
    expect(JSON.stringify(top20.content)).toContain(
      "without another retrieval",
    );

    const top40 = await tools.searchMore.execute("top-40", {});
    expect(top40.details.candidates.map((item) => item.memoryId)).toEqual(
      records.slice(20, 40).map((record) => record.memoryId),
    );
    const top60 = await tools.searchMore.execute("top-60", {});
    expect(top60.details.candidates.map((item) => item.memoryId)).toEqual(
      records.slice(40, 60).map((record) => record.memoryId),
    );
    const top80 = await tools.searchMore.execute("top-80", {});
    expect(top80.details.candidates.map((item) => item.memoryId)).toEqual(
      records.slice(60, 80).map((record) => record.memoryId),
    );
    expect(top80.details.pagination?.hasMore).toBe(false);
    expect(requestedLimits).toEqual([80]);
    expect(new Set(ledger.candidates.map((item) => item.memoryId)).size).toBe(80);
    await expect(tools.searchMore.execute("exhausted", {})).rejects.toThrow(
      /no continuation page/iu,
    );
    await expect(tools.search.execute("new-search", {
      queries: ["another query"],
    })).rejects.toThrow(/search budget exhausted/iu);
  });

  it("bounds the combined current and earlier compact directories to 80 entries", async () => {
    const groups = new Map([
      ["first pool", Array.from({ length: 80 }, (_, index) =>
        memory(`a-${String(index + 1)}`, `a-session-${String(index + 1)}`, 0))],
      ["second pool", Array.from({ length: 80 }, (_, index) =>
        memory(`b-${String(index + 1)}`, `b-session-${String(index + 1)}`, 0))],
    ]);
    const operator: SearchOperator = {
      id: "two-pools",
      version: "1",
      guide: {
        summary: "Return two disjoint physical pools.",
        useWhen: ["Testing bounded observation state."],
        cost: "low",
      },
      execute(_context, input) {
        const query = input.queries[0]!;
        const records = groups.get(query) ?? [];
        return Promise.resolve({
          request: { queries: [...input.queries], limit: input.limit },
          hits: records.map((record, index) => hit(record, query, index + 1)),
        });
      },
    };
    const ledger = new MemoryLedger("scope-1");
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: new SearchOperatorRegistry("two-pools")
        .register(operator)
        .freeze(),
      scopeId: "scope-1",
      ledger,
    });

    await tools.search.execute("first", { queries: ["first pool"] });
    const second = await tools.search.execute("second", {
      queries: ["second pool"],
    });
    const rendered = JSON.stringify(second.content);
    const directoryLines = rendered.match(/- read C\d+/gu) ?? [];

    expect(second.details.directoryCandidates).toHaveLength(60);
    expect(ledger.candidates).toHaveLength(160);
    expect(directoryLines).toHaveLength(80);
    expect(rendered).toContain(
      "60 older directory candidate(s) are omitted from this bounded snapshot",
    );
  });

  it("rolls back a failed search reservation so budget, metrics, and observation agree", async () => {
    const source = memory("m-success", "session-success", 0);
    let attempts = 0;
    const operator: SearchOperator = {
      id: "flaky-search",
      version: "1",
      guide: { summary: "Fail once.", useWhen: ["Testing."], cost: "low" },
      execute(_context, input) {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic retrieval failure");
        return Promise.resolve({
          request: { queries: [...input.queries], limit: input.limit },
          hits: [hit(source, input.queries[0]!, 1)],
        });
      },
    };
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: new SearchOperatorRegistry("flaky-search")
        .register(operator)
        .freeze(),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
      maxSearchCalls: 1,
    });

    await expect(tools.search.execute("failed", {
      queries: ["same semantic need"],
    })).rejects.toThrow(/synthetic retrieval failure/u);
    const successful = await tools.search.execute("successful", {
      queries: ["same semantic need"],
    });
    expect(JSON.stringify(successful.content)).toContain("Searches remaining: 0");
    expect(attempts).toBe(2);
    await expect(tools.search.execute("over-budget", {
      queries: ["another need"],
    })).rejects.toThrow(/search budget exhausted/iu);
  });

  it("never exposes full-reservoir operator derivations through a bounded page", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      memory(`numeric-${String(index + 1)}`, `session-${String(index + 1)}`, 0)
    );
    const operator: SearchOperator = {
      id: "numeric-page",
      version: "1",
      guide: { summary: "Return numeric rows.", useWhen: ["Testing."], cost: "low" },
      execute(_context, input) {
        const hits = records.map((record, index) =>
          hit(record, input.queries[0]!, index + 1)
        );
        return Promise.resolve({
          request: { queries: [...input.queries], limit: input.limit },
          hits,
          operatorResult: {
            version: "picorer-evidence-operators-v1",
            operator: "numeric",
            // Hidden reservoir hits deliberately have no rows. The opaque
            // derived value must still not cross the visible-page boundary.
            rows: records.slice(0, 20).map((record, index) => ({
              slot: input.queries[0]!,
              quote: `value ${String(index + 1)}`,
              memoryId: record.memoryId,
              sessionId: record.sessionId,
              turnIndex: record.turnIndex,
              role: record.role,
              value: index + 1,
            })),
            coverage: {
              candidateCount: records.length,
              distinctSessions: records.length,
              truncated: false,
            },
            derived: {
              latestCumulativeOrSnapshot: 25,
              latestMemoryId: "numeric-25",
            },
          },
        });
      },
    };
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: new SearchOperatorRegistry("numeric-page")
        .register(operator)
        .freeze(),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const initial = await tools.search.execute("bounded", {
      queries: ["numeric history"],
      // Direct callers are also capped to the schema's visible-page limit.
      limit: 80,
    });
    expect(initial.details.request.limit).toBe(20);
    expect(initial.details.candidates).toHaveLength(20);
    expect(initial.details.operatorResult?.rows).toHaveLength(20);
    expect(initial.details.operatorResult?.derived).toBeUndefined();
    expect(JSON.stringify(initial.content)).not.toContain(
      "latestCumulativeOrSnapshot",
    );
    expect(JSON.stringify(initial.content)).toContain(
      "Additional candidates from the same search",
    );
    expect(JSON.stringify(initial.content)).toContain("read C25");
    expect(JSON.stringify(initial.content)).toContain("numeric-25 source text");
  });

  it("keeps derived data hidden on the final continuation page", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      memory(`final-page-${String(index + 1)}`, `session-${String(index + 1)}`, 0)
    );
    const operator: SearchOperator = {
      id: "final-derived-page",
      version: "1",
      guide: { summary: "Return a final-page calculation.", useWhen: ["Testing."], cost: "low" },
      execute(_context, input) {
        return Promise.resolve({
          request: { queries: [...input.queries], limit: input.limit },
          hits: records.map((record, index) =>
            hit(record, input.queries[0]!, index + 1)
          ),
          operatorResult: {
            version: "picorer-evidence-operators-v1",
            operator: "numeric",
            rows: records.slice(20).map((record, index) => ({
              slot: input.queries[0]!,
              quote: record.content,
              memoryId: record.memoryId,
              sessionId: record.sessionId,
              turnIndex: record.turnIndex,
              role: record.role,
              value: index + 21,
            })),
            coverage: {
              candidateCount: records.length,
              distinctSessions: records.length,
              truncated: false,
            },
            derived: { fullReservoirSecret: "MUST_NOT_REACH_FINAL_PAGE" },
          },
        });
      },
    };
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: new SearchOperatorRegistry("final-derived-page")
        .register(operator)
        .freeze(),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const initial = await tools.search.execute("initial-derived", {
      queries: ["final page values"],
    });
    expect(initial.details.operatorResult?.derived).toBeUndefined();

    const finalPage = await tools.searchMore.execute("final-derived", {});
    expect(finalPage.details.pagination?.hasMore).toBe(false);
    expect(finalPage.details.operatorResult?.rows).toHaveLength(5);
    expect(finalPage.details.operatorResult?.derived).toBeUndefined();
    expect(JSON.stringify(finalPage.content)).not.toContain(
      "MUST_NOT_REACH_FINAL_PAGE",
    );
  });

  it("does not bind an operator row to a different passage of the same parent", async () => {
    const query = "common anchor";
    const secretQuote = "SECRET_OPERATOR_QUOTE_FROM_HIDDEN_PASSAGE";
    const sharedFragment = "VISIBLE_SHARED_FRAGMENT_FOR_OPERATOR";
    const operatorQuote = `${sharedFragment} ... ${secretQuote}`;
    const visibleContent =
      `${query} ${sharedFragment}, but this passage lacks the hidden fact.`;
    const hiddenContent =
      `${query} ${"unrelated filler ".repeat(50)}` +
      `${operatorQuote} ${"unrelated tail ".repeat(20)}`;
    const parent = {
      ...memory("shared-passage-parent", "shared-session", 0),
      content: `${visibleContent}\n\n${hiddenContent}`,
      contentHash: "shared-passage-parent-hash",
    };
    const hiddenStart = visibleContent.length + 2;
    const sourceBoundId = (start: number, end: number): string => `P-${sha256(JSON.stringify([
      PASSAGE_VIEW_VERSION, parent.memoryId, parent.contentHash, start, end,
    ])).slice(0, 24)}`;
    const visibleId = sourceBoundId(0, visibleContent.length);
    const hiddenId = sourceBoundId(hiddenStart, parent.content.length);
    const hits: RetrievalHit[] = [
      {
        ...hit(parent, query, 1),
        preview: visibleContent,
        passage: {
          passageId: visibleId,
          parentMemoryId: parent.memoryId,
          sourceContentHash: parent.contentHash,
          index: 0,
          start: 0,
          end: visibleContent.length,
          content: visibleContent,
        },
      },
      {
        ...hit(parent, query, 2),
        preview: hiddenContent,
        passage: {
          passageId: hiddenId,
          parentMemoryId: parent.memoryId,
          sourceContentHash: parent.contentHash,
          index: 1,
          start: hiddenStart,
          end: parent.content.length,
          content: hiddenContent,
        },
      },
    ];
    const operator: SearchOperator = {
      id: "passage-row-binding",
      version: "1",
      guide: { summary: "Return passage candidates.", useWhen: ["Testing."], cost: "low" },
      execute(_context, input) {
        return Promise.resolve({
          request: { queries: [...input.queries], limit: input.limit },
          hits,
          operatorResult: {
            version: "picorer-evidence-operators-v1",
            operator: "numeric",
            rows: [{
              slot: query,
              quote: operatorQuote,
              memoryId: parent.memoryId,
              sessionId: parent.sessionId,
              turnIndex: parent.turnIndex,
              role: parent.role,
              value: 42,
            }],
            coverage: {
              candidateCount: 1,
              distinctSessions: 1,
              truncated: false,
            },
          },
        });
      },
    };
    const tools = createPicorerTools({
      store: { search: () => [], read: () => [] },
      operatorRegistry: new SearchOperatorRegistry("passage-row-binding")
        .register(operator)
        .freeze(),
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    const initial = await tools.search.execute("passage-page", {
      queries: [query],
      limit: 1,
    });
    expect(initial.details.candidates[0]?.candidateId).toBe(visibleId);
    expect(initial.details.directoryCandidates?.[0]?.candidateId).toBe(
      hiddenId,
    );
    expect(initial.details.operatorResult?.rows).toEqual([]);
    expect(JSON.stringify(initial.content)).not.toContain(secretQuote);
  });

  it("admits session breadth in rounds while preserving later session depth", () => {
    const records = [
      memory("a-1", "session-a", 0),
      memory("a-2", "session-a", 1),
      memory("a-3", "session-a", 2),
      memory("b-1", "session-b", 0),
      memory("b-2", "session-b", 1),
      memory("c-1", "session-c", 0),
    ];
    const hits = records.map((record, index) =>
      hit(record, "festival events", index + 1)
    );

    const selected = finalizeSearchHits(hits, {
      queries: ["festival events"],
      limit: 5,
      maxPerSession: 2,
      order: "relevance",
    }, 5);

    expect(selected.map((item) => item.record.memoryId)).toEqual([
      "a-1",
      "b-1",
      "c-1",
      "a-2",
      "b-2",
    ]);
  });

  it("round-robins a bounded union instead of letting its first search monopolize it", async () => {
    const shared = memory("shared", "shared-session", 0);
    const lists = new Map<string, MemoryRecord[]>([
      ["left", [memory("left-1", "left-session", 0), shared,
        memory("left-3", "left-session", 2)]],
      ["right", [memory("right-1", "right-session", 0), shared,
        memory("right-3", "right-session", 2)]],
    ]);
    const listOperator = (id: string): SearchOperator => ({
      id,
      version: "1",
      guide: { summary: id, useWhen: [id], cost: "low" },
      execute(_context, input) {
        const query = input.queries[0]!;
        return Promise.resolve({
          request: {
            queries: [...input.queries],
            limit: input.limit,
            order: "relevance",
          },
          hits: lists.get(id)!.map((record, index) =>
            hit(record, query, index + 1)
          ),
        });
      },
    });
    const registry = new SearchOperatorRegistry("left")
      .register(listOperator("left"))
      .register(listOperator("right"))
      .freeze()
      .forkForRun();
    registry.define({
      id: "fair-union",
      version: "1",
      guide: { summary: "fair union", useWhen: ["coverage"], cost: "low" },
      steps: [
        { id: "left", kind: "search", operator: "left", queries: ["left path"] },
        { id: "right", kind: "search", operator: "right", queries: ["right path"] },
        {
          id: "union",
          kind: "combine",
          inputs: ["left", "right"],
          method: "union",
          limit: 4,
        },
      ],
      output: "union",
    });

    const output = await registry.get("fair-union").execute(
      { scopeId: "scope-1" },
      { queries: ["fallback"], limit: 4 },
    );

    expect(output.hits.map((item) => item.record.memoryId)).toEqual([
      "left-1",
      "right-1",
      "shared",
      "left-3",
    ]);
    expect(output.hits[2]?.matchedQueries).toEqual([
      "left path",
      "right path",
    ]);
  });
});
