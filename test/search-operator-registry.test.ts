import { describe, expect, it } from "vitest";
import { MemoryLedger, createPicorerTools } from "../src/evidence-agent/index.js";
import {
  renderSearchOperatorCatalog,
  SearchOperatorRegistry,
  type MemoryToolStore,
  type SearchOperator,
} from "../src/retrieval/index.js";
import type { MemoryRecord } from "../src/memory/index.js";
import {
  createSearchOperatorRegistry,
  createSelectedSearchOperatorRegistry,
} from "../src/composition/create-search-operator-registry.js";

function customOperator(memory: MemoryRecord): SearchOperator {
  return {
    id: "entity-expand",
    version: "1",
    guide: {
      summary: "Follow explicit entity associations.",
      useWhen: ["A known entity should lead to related source memories."],
      avoidWhen: ["No entity anchor is available."],
      cost: "medium",
    },
    async execute(context, input) {
      return {
        request: {
          queries: [...input.queries],
          limit: input.limit,
          order: "relevance",
        },
        hits: [{
          record: memory,
          query: input.queries[0] ?? "",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: memory.content,
        }],
      };
    },
  };
}

describe("SearchOperatorRegistry", () => {
  it("builds exactly the composition-selected built-in catalog", () => {
    const store: MemoryToolStore = {
      search: () => [],
      read: () => [],
    };
    const registry = createSelectedSearchOperatorRegistry(
      store,
      ["lexical", "chronological"],
    );

    expect(registry.list().map((entry) => entry.id)).toEqual([
      "lexical",
      "chronological",
    ]);
    expect(() => createSelectedSearchOperatorRegistry(store, []))
      .toThrow(/at least one built-in/iu);
    expect(() => createSelectedSearchOperatorRegistry(store, ["missing"]))
      .toThrow(/unknown built-in/iu);
  });

  it("exposes only primitive retrievers in the default catalog", () => {
    const store: MemoryToolStore = { search: () => [], read: () => [] };

    expect(createSearchOperatorRegistry(store).list().map((entry) => entry.id))
      .toEqual([
        "hybrid",
        "lexical",
        "chronological",
        "temporal-index",
        "numeric-index",
      ]);
  });

  it("makes a newly registered operator available without changing the tool or Skill", async () => {
    const memory: MemoryRecord = {
      memoryId: "memory-1",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "Alice introduced Bob to the project.",
      contentHash: "hash-1",
      metadata: {},
    };
    const registry = new SearchOperatorRegistry("entity-expand")
      .register(customOperator(memory))
      .freeze();
    const store: MemoryToolStore = {
      search() {
        throw new Error("The custom operator must own candidate discovery");
      },
      read() {
        return [memory];
      },
    };
    const tools = createPicorerTools({
      store,
      operatorRegistry: registry,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    expect(JSON.stringify(tools.search.parameters)).toContain("entity-expand");
    expect(JSON.stringify(tools.search.parameters)).toContain(
      "do not append @version",
    );
    expect(JSON.stringify(tools.search.parameters)).toContain(
      "Never submit more than 16 queries",
    );
    expect(tools.search.description).toContain("Follow explicit entity associations");
    expect(tools.search.description).toContain("id=entity-expand | version=1");
    expect(tools.search.description).not.toContain("entity-expand@1");

    const result = await tools.search.execute("search-custom", {
      operator: "entity-expand",
      queries: ["Alice Bob"],
      limit: 5,
    });

    expect(result.details).toMatchObject({
      operator: "entity-expand",
      operatorVersion: "1",
      candidates: [expect.objectContaining({ memoryId: "memory-1" })],
    });
  });

  it("renders callable operator IDs separately from informational versions", () => {
    const rendered = renderSearchOperatorCatalog([{
      id: "entity-expand",
      version: "2026-08-25",
      guide: {
        summary: "Follow explicit entity associations.",
        useWhen: ["A known entity should lead to related source memories."],
        cost: "medium",
      },
    }]);

    expect(rendered).toContain(
      "pass the id exactly as search.operator; version is informational",
    );
    expect(rendered).toContain("id=entity-expand | version=2026-08-25");
    expect(rendered).not.toContain("entity-expand@2026-08-25");
  });

  it("rejects duplicate, unknown, and post-freeze registration", () => {
    const memory: MemoryRecord = {
      memoryId: "memory-1",
      scopeId: "scope-1",
      sessionId: "session-1",
      turnIndex: 0,
      role: "user",
      content: "source",
      contentHash: "hash-1",
      metadata: {},
    };
    const operator = customOperator(memory);
    const registry = new SearchOperatorRegistry("entity-expand")
      .register(operator);

    expect(() => registry.register(operator)).toThrow(/already registered/iu);
    expect(() => registry.list()).toThrow(/must be frozen/iu);
    registry.freeze();
    expect(() => registry.get("missing")).toThrow(/unknown search operator/iu);
    expect(() => registry.register({ ...operator, id: "another" })).toThrow(
      /registry is frozen/iu,
    );
  });

  it("round-robins coverage candidates across sessions before taking seconds", async () => {
    const sessionOneFirst = customMemory("session-one-first", "session-one", 0);
    const sessionOneSecond = customMemory("session-one-second", "session-one", 1);
    const sessionTwo = customMemory("session-two", "session-two", 0);
    const sessionThree = customMemory("session-three", "session-three", 0);
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        const query = request.queries[0];
        const memories = query === "first need"
          ? [sessionOneFirst, sessionOneSecond, sessionTwo]
          : [sessionOneFirst, sessionThree];
        return memories.map((memory, index) => ({
          record: memory,
          query: query ?? "",
          retriever: "fts5" as const,
          rank: index + 1,
          score: 1 / (index + 1),
          preview: memory.content,
        }));
      },
      read: () => [],
    };
    const registry = createSelectedSearchOperatorRegistry(store, ["hybrid"])
      .forkForRun();
    registry.define({
      id: "broad-sessions",
      version: "run-1",
      guide: { summary: "breadth", useWhen: ["breadth"], cost: "medium" },
      steps: [
        { id: "first", kind: "search", operator: "hybrid", queries: ["first need"] },
        { id: "second", kind: "search", operator: "hybrid", queries: ["second need"] },
        { id: "fused", kind: "combine", inputs: ["first", "second"], method: "rrf" },
        { id: "sessions", kind: "diversify", input: "fused", by: "session", maxPerGroup: 1 },
        { id: "top", kind: "limit", input: "sessions", limit: 3 },
      ],
      output: "top",
    });

    const output = await registry.get("broad-sessions").execute(
      { scopeId: "scope-1" },
      { queries: ["fallback"], limit: 20 },
    );

    expect(new Set(output.hits.map((hit) => hit.record.sessionId))).toEqual(
      new Set(["session-one", "session-two", "session-three"]),
    );
    expect(output.hits).toHaveLength(3);
  });

  it("pushes session coverage and role constraints into candidate generation", async () => {
    const sessionOneFirst = customMemory("session-one-first", "session-one", 0);
    const sessionOneSecond = customMemory("session-one-second", "session-one", 1);
    const sessionOneAssistant = {
      ...customMemory("session-one-assistant", "session-one", 2),
      role: "assistant" as const,
    };
    const sessionTwo = customMemory("session-two", "session-two", 0);
    const memories = [
      sessionOneFirst,
      sessionOneAssistant,
      sessionOneSecond,
      sessionTwo,
    ];
    const requests: Array<{
      roles?: string[];
      maxPerSession?: number;
    }> = [];
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        requests.push({
          ...(request.roles === undefined ? {} : { roles: [...request.roles] }),
          ...(request.maxPerSession === undefined
            ? {}
            : { maxPerSession: request.maxPerSession }),
        });
        const roles = request.roles === undefined
          ? undefined
          : new Set(request.roles);
        const sessionCounts = new Map<string, number>();
        const selected = [];
        for (const memory of memories) {
          if (roles !== undefined && !roles.has(memory.role)) continue;
          const count = sessionCounts.get(memory.sessionId) ?? 0;
          if (
            request.maxPerSession !== undefined &&
            count >= request.maxPerSession
          ) continue;
          selected.push(memory);
          sessionCounts.set(memory.sessionId, count + 1);
          if (selected.length === (request.limit ?? 20)) break;
        }
        return selected.map((memory, index) => ({
          record: memory,
          query: request.queries[0] ?? "",
          retriever: "fts5" as const,
          rank: index + 1,
          score: 1 / (index + 1),
          preview: memory.content,
        }));
      },
      read: () => [],
    };
    const registry = createSelectedSearchOperatorRegistry(store, ["hybrid"])
      .forkForRun();
    registry.define({
      id: "session-coverage",
      version: "run-1",
      guide: { summary: "coverage", useWhen: ["coverage"], cost: "medium" },
      steps: [
        { id: "source", kind: "search", operator: "hybrid" },
        { id: "users", kind: "filter", input: "source", roles: ["user"] },
        {
          id: "sessions",
          kind: "diversify",
          input: "users",
          by: "session",
          maxPerGroup: 1,
        },
        { id: "top", kind: "limit", input: "sessions", limit: 2 },
      ],
      output: "top",
    });

    const output = await registry.get("session-coverage").execute(
      { scopeId: "scope-1" },
      { queries: ["class schedule"], limit: 2 },
    );

    expect(requests).toEqual([{ roles: ["user"], maxPerSession: 1 }]);
    expect(output.hits.map((hit) => hit.record.memoryId)).toEqual([
      "session-one-first",
      "session-two",
    ]);
    expect(output.composition?.steps[0]).toMatchObject({
      kind: "search",
      roles: ["user"],
      maxPerSession: 1,
      candidateCount: 2,
    });
  });

  it("keeps depth in the strongest sessions when matches exceed the result limit", async () => {
    const primaryFirst = customMemory("primary-first", "primary", 0);
    const primarySecond = customMemory("primary-second", "primary", 1);
    const secondaryFirst = customMemory("secondary-first", "secondary", 0);
    const secondarySecond = customMemory("secondary-second", "secondary", 1);
    const distractors = Array.from({ length: 4 }, (_, index) =>
      customMemory(`distractor-${String(index)}`, `distractor-${String(index)}`, 0)
    );
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        const query = request.queries[0] ?? "";
        const memories = query === "first need"
          ? [
              primaryFirst,
              primarySecond,
              secondaryFirst,
              secondarySecond,
              ...distractors,
            ]
          : [primaryFirst, primarySecond, secondaryFirst, secondarySecond];
        return memories.map((memory, index) => ({
          record: memory,
          query,
          retriever: "fts5" as const,
          rank: index + 1,
          score: 1 / (index + 1),
          preview: memory.content,
        }));
      },
      read: () => [],
    };
    const registry = createSelectedSearchOperatorRegistry(store, ["hybrid"])
      .forkForRun();
    registry.define({
      id: "deep-sessions",
      version: "run-1",
      guide: { summary: "depth", useWhen: ["depth"], cost: "medium" },
      steps: [
        { id: "first", kind: "search", operator: "hybrid", queries: ["first need"] },
        { id: "second", kind: "search", operator: "hybrid", queries: ["second need"] },
        { id: "fused", kind: "combine", inputs: ["first", "second"], method: "rrf", limit: 4 },
        { id: "sessions", kind: "diversify", input: "fused", by: "session", maxPerGroup: 2 },
      ],
      output: "sessions",
    });

    const output = await registry.get("deep-sessions").execute(
      { scopeId: "scope-1" },
      { queries: ["fallback"], limit: 20 },
    );

    expect(output.hits.map((hit) => hit.record.memoryId)).toEqual([
      "primary-first",
      "secondary-first",
      "primary-second",
      "secondary-second",
    ]);
  });

  it("turns a relative-date question into an auxiliary temporal search", async () => {
    const memory = {
      ...customMemory("target-date", "dated-session"),
      content: "I bought a smoker for the kitchen.",
      timestamp: "2023-03-15T09:00:00",
    };
    const requests: Array<{ after?: string; before?: string }> = [];
    const expansionDates: string[][] = [];
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        requests.push({
          ...(request.after === undefined ? {} : { after: request.after }),
          ...(request.before === undefined ? {} : { before: request.before }),
        });
        if (request.after === undefined) return [];
        return [{
          record: memory,
          query: request.queries[0] ?? "",
          retriever: "fts5" as const,
          rank: 1,
          score: 1,
          preview: memory.content,
        }];
      },
      expandEvidenceOperator(_scopeId, _request, context, seeds) {
        expansionDates.push(context.targetDates ?? []);
        return seeds.map((seed, index) => ({
          ...seed,
          query: "database timeline dates 2023-03-15",
          retriever: "picorer-timeline-db" as const,
          rank: index + 1,
          score: 1 / (61 + index),
          preview: seed.record.content,
          operatorTemporalFacts: [{
            expression: "source timestamp",
            resolvedDate: "2023-03-15",
            basis: "source-timestamp",
          }],
        }));
      },
      read: () => [],
    };
    const registry = createSelectedSearchOperatorRegistry(
      store,
      ["temporal-index"],
    ).forkForRun();
    registry.define({
      id: "dated-evidence",
      version: "run-1",
      guide: { summary: "dates", useWhen: ["dates"], cost: "medium" },
      steps: [
        { id: "dates", kind: "search", operator: "temporal-index" },
        { id: "timeline", kind: "annotate", input: "dates", method: "temporal" },
      ],
      output: "timeline",
    });

    const output = await registry.get("dated-evidence").execute(
      {
        scopeId: "scope-1",
        question: "What kitchen appliance did I buy 10 days ago?",
        questionDate: "2023/03/25 (Sat) 18:26",
      },
      { queries: ["kitchen appliance purchase"], limit: 20 },
    );

    expect(requests).toEqual([
      {},
      {
        after: "2023-03-15T00:00:00",
        before: "2023-03-15T23:59:59.999",
      },
    ]);
    expect(expansionDates).toEqual([["2023-03-15"]]);
    expect(output.hits.map((hit) => hit.record.memoryId)).toEqual(["target-date"]);
    expect(output.operatorResult?.temporalPlan).toMatchObject({
      auxiliaryWindowApplied: false,
      targets: [{ date: "2023-03-15" }],
    });
  });

  it("keeps Agent-defined operators private to one run and composes CandidateSets", async () => {
    const memories = [
      { ...customMemory("memory-a"), content: "alpha" },
      { ...customMemory("memory-b"), content: "shared" },
      { ...customMemory("memory-c"), content: "gamma" },
    ];
    const base = new SearchOperatorRegistry("left")
      .register(hitListOperator("left", [memories[0]!, memories[1]!]))
      .register(hitListOperator("right", [memories[1]!, memories[2]!]))
      .freeze();
    const run = base.forkForRun();
    const sibling = base.forkForRun();

    const defined = run.define({
      id: "balanced-recall",
      version: "run-1",
      guide: {
        summary: "Fuse exact and semantic recall.",
        useWhen: ["Both recall paths are useful."],
        cost: "medium",
      },
      steps: [
        { id: "exact", kind: "search", operator: "left" },
        { id: "semantic", kind: "search", operator: "right" },
        {
          id: "fused",
          kind: "combine",
          inputs: ["exact", "semantic"],
          method: "rrf",
        },
      ],
      output: "fused",
    });
    const output = await run.get("balanced-recall").execute(
      { scopeId: "scope-1" },
      { queries: ["shared"], limit: 3 },
    );

    expect(defined.catalog).toMatchObject({ revision: 1 });
    expect(defined.definitionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(output.hits.map((hit) => hit.record.memoryId)).toEqual([
      "memory-b",
      "memory-a",
      "memory-c",
    ]);
    expect(output.composition).toMatchObject({
      definitionHash: defined.definitionHash,
      definitionRevision: 1,
      steps: [
        { id: "exact", candidateCount: 2 },
        { id: "semantic", candidateCount: 2 },
        { id: "fused", candidateCount: 3 },
      ],
    });
    expect(() => base.get("balanced-recall")).toThrow(/unknown/iu);
    expect(() => sibling.get("balanced-recall")).toThrow(/unknown/iu);
  });

  it("executes fusion and typed transformations as one ordered plan", async () => {
    const duplicateEarly = {
      ...customMemory("duplicate-early", "session-early"),
      content: "The total is $10.",
      timestamp: "2024-01-01T00:00:00",
    };
    const duplicateLate = {
      ...customMemory("duplicate-late", "session-late"),
      content: "The total is $10.",
      timestamp: "2024-01-02T00:00:00",
    };
    const final = {
      ...customMemory("final", "session-final"),
      content: "The total is $20.",
      timestamp: "2024-01-03T00:00:00",
    };
    const assistant = {
      ...customMemory("assistant", "session-assistant"),
      role: "assistant" as const,
      timestamp: "2024-01-04T00:00:00",
    };
    const base = new SearchOperatorRegistry("left")
      .register(hitListOperator("left", [
        duplicateLate,
        assistant,
        duplicateEarly,
        final,
      ]))
      .register(hitListOperator("right", [duplicateEarly, duplicateLate, final]))
      .freeze();
    const run = base.forkForRun();
    run.define({
      id: "typed-plan",
      version: "run-1",
      guide: { summary: "typed", useWhen: ["typed"], cost: "high" },
      steps: [
        { id: "left", kind: "search", operator: "left" },
        { id: "right", kind: "search", operator: "right" },
        { id: "all", kind: "combine", inputs: ["left", "right"], method: "union" },
        { id: "common", kind: "combine", inputs: ["all", "right"], method: "intersection" },
        { id: "users", kind: "filter", input: "common", roles: ["user"] },
        { id: "ordered", kind: "sort", input: "users", order: "chronological" },
        { id: "unique", kind: "dedupe", input: "ordered", by: "content" },
        { id: "sessions", kind: "diversify", input: "unique", by: "session", maxPerGroup: 1 },
        { id: "top", kind: "limit", input: "sessions", limit: 2 },
        { id: "values", kind: "annotate", input: "top", method: "numeric" },
      ],
      output: "values",
    });

    const output = await run.get("typed-plan").execute(
      { scopeId: "scope-1", question: "What totals were stated?" },
      { queries: ["total"], limit: 20 },
    );

    expect(output.hits.map((hit) => hit.record.memoryId)).toEqual([
      "duplicate-early",
      "final",
    ]);
    expect(output.operatorResult?.operator).toBe("numeric");
    expect(output.composition?.steps.map((step) => step.kind)).toEqual([
      "search",
      "search",
      "combine",
      "combine",
      "filter",
      "sort",
      "dedupe",
      "diversify",
      "limit",
      "annotate",
    ]);
    expect(output.composition?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "users", candidateCount: 3 }),
      expect.objectContaining({ id: "unique", candidateCount: 2 }),
    ]));
  });

  it("rejects unsafe or cognitively unbounded run definitions", () => {
    const base = new SearchOperatorRegistry("left")
      .register(hitListOperator("left", [customMemory("memory-a")]))
      .register(hitListOperator("right", [customMemory("memory-b")]))
      .register(hitListOperator("third", [customMemory("memory-c")]))
      .register(hitListOperator("fourth", [customMemory("memory-d")]))
      .register(hitListOperator("fifth", [customMemory("memory-e")]))
      .freeze();
    const run = base.forkForRun(2);

    expect(() => run.define({
      id: "forward-reference",
      version: "run-1",
      guide: { summary: "bad", useWhen: ["bad"], cost: "low" },
      steps: [{
        id: "fused",
        kind: "combine",
        inputs: ["later", "later"],
        method: "union",
      }, { id: "later", kind: "search", operator: "left" }],
      output: "fused",
    })).toThrow(/unavailable prior step/iu);
    expect(() => run.define({
      id: "recursive",
      version: "run-1",
      guide: { summary: "bad", useWhen: ["bad"], cost: "low" },
      steps: [{ id: "self", kind: "search", operator: "recursive" }],
      output: "self",
    })).toThrow(/cannot call itself/iu);
    expect(() => run.define({
      id: "unused-work",
      version: "run-1",
      guide: { summary: "bad", useWhen: ["bad"], cost: "low" },
      steps: [
        { id: "used", kind: "search", operator: "left" },
        { id: "unused", kind: "search", operator: "right" },
      ],
      output: "used",
    })).toThrow(/unused steps/iu);
    expect(() => run.define({
      id: "too-wide",
      version: "run-1",
      guide: { summary: "bad", useWhen: ["bad"], cost: "high" },
      steps: Array.from({ length: 5 }, (_, index) => ({
        id: `search-${index}`,
        kind: "search" as const,
        operator: ["left", "right", "third", "fourth", "fifth"][index]!,
      })),
      output: "search-4",
    })).toThrow(/at most 4 search steps/iu);
  });

  it("lets the Agent define and immediately invoke an operator through one small tool", async () => {
    const memory = customMemory("memory-1");
    const base = new SearchOperatorRegistry("left")
      .register(hitListOperator("left", [memory]))
      .freeze();
    const run = base.forkForRun();
    const store: MemoryToolStore = { search: () => [], read: () => [memory] };
    const tools = createPicorerTools({
      store,
      operatorRegistry: run,
      operatorDefinitions: run,
      scopeId: "scope-1",
      ledger: new MemoryLedger("scope-1"),
    });

    expect(tools.defineOperator).toBeDefined();
    const definitionSchema = JSON.stringify(tools.defineOperator!.parameters);
    expect(definitionSchema).toContain('"steps"');
    expect(definitionSchema).toContain("diversify");
    expect(definitionSchema).not.toContain('"filter"');
    expect(definitionSchema).not.toContain('"roles"');
    expect(definitionSchema).not.toContain('"output"');
    expect(definitionSchema).not.toContain('"by"');
    await expect(tools.defineOperator!.execute("define-stale-filter", {
      id: "stale-role-plan",
      summary: "A stale client attempts to restore a model-owned role filter.",
      steps: [
        { id: "source", kind: "search", operator: "left" },
        { id: "user", kind: "filter", input: "source", roles: ["user"] },
      ],
    } as never)).rejects.toThrow(/harness-owned/iu);
    const definitionResult = await tools.defineOperator!.execute("define-1", {
      id: "focused-left",
      summary: "Reuse exact recall with a stable name.",
      steps: [
        { id: "source", kind: "search", operator: "left" },
        { id: "unique", kind: "dedupe", input: "source" },
        {
          id: "sessions",
          kind: "diversify",
          input: "unique",
          maxPerGroup: 1,
        },
      ],
    });
    const searchResult = await tools.search.execute("search-1", {
      operator: "focused-left",
      queries: ["source"],
      limit: 5,
    });

    expect(definitionResult.details).toMatchObject({
      kind: "define_operator",
      definition: { id: "focused-left", catalog: { revision: 1 } },
      snapshot: {
        revision: 1,
        definition: {
          id: "focused-left",
          output: "sessions",
          steps: expect.arrayContaining([
            expect.objectContaining({ id: "unique", by: "content" }),
            expect.objectContaining({ id: "sessions", by: "session" }),
          ]),
        },
      },
    });
    expect(searchResult.details).toMatchObject({
      operator: "focused-left",
      candidates: [expect.objectContaining({ memoryId: "memory-1" })],
      composition: { definitionRevision: 1 },
    });
    expect(JSON.stringify(searchResult.content)).toContain("Latest search plan");
    expect(JSON.stringify(searchResult.content)).toContain(
      'Search left for \\"source\\"',
    );
    expect(JSON.stringify(searchResult.content)).toContain("Remove duplicate content");
    expect(JSON.stringify(searchResult.content)).not.toContain("users: filter");
    await expect(tools.defineOperator!.execute("define-2", {
      id: "nested",
      summary: "Do not permit recursive composition growth.",
      steps: [{ id: "source", kind: "search", operator: "focused-left" }],
    })).rejects.toThrow(/initial catalog/iu);
  });
});

function customMemory(
  memoryId: string,
  sessionId = "session-1",
  turnIndex = 0,
): MemoryRecord {
  return {
    memoryId,
    scopeId: "scope-1",
    sessionId,
    turnIndex,
    role: "user",
    content: memoryId,
    contentHash: `hash-${memoryId}`,
    metadata: {},
  };
}

function hitListOperator(
  id: string,
  memories: readonly MemoryRecord[],
): SearchOperator {
  return {
    id,
    version: "1",
    guide: { summary: id, useWhen: [id], cost: "low" },
    async execute(_context, input) {
      return {
        request: { queries: [...input.queries], limit: input.limit },
        hits: memories.map((memory, index) => ({
          record: memory,
          query: input.queries[0] ?? "",
          retriever: "fts5" as const,
          rank: index + 1,
          score: 1 / (index + 1),
          preview: memory.content,
        })),
      };
    },
  };
}
