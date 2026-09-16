import { describe, expect, it } from "vitest";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import {
  createPicorerTools,
  type MemoryToolStore,
} from "../src/evidence-agent/adapters/pi/tools.js";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";
import { createWorkingMemoryContext } from "../src/evidence-agent/adapters/pi/working-memory-context.js";
import type { MemoryRecord } from "../src/memory/index.js";

function source(index: number, content = `Fact ${String(index)}.`): MemoryRecord {
  return {
    memoryId: `m${String(index)}`,
    scopeId: "compact-scope",
    sessionId: `s${String(index)}`,
    turnIndex: 0,
    role: "user",
    content,
    contentHash: `hash-${String(index)}`,
    metadata: {},
  };
}

describe("compact agent interface", () => {
  it("keeps composable operators while paging a bounded candidate view", async () => {
    const records = Array.from({ length: 30 }, (_, index) => source(index + 1));
    let semanticSearches = 0;
    let lexicalSearches = 0;
    const hits = (query: string) => records.map((record, index) => ({
      record,
      query,
      retriever: "fts5" as const,
      rank: index + 1,
      score: 1 / (index + 1),
      preview: record.content,
    }));
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        semanticSearches += 1;
        return hits(request.queries[0]!);
      },
      searchLexical(_scopeId, request) {
        lexicalSearches += 1;
        return hits(request.queries[0]!);
      },
      read(_scopeId, memoryIds) {
        return records.filter((record) => memoryIds.includes(record.memoryId));
      },
    };
    /*
     * The compact presentation changes only what the model sees. It must not
     * project away the composable v1.4 search contract.
     */
    const operatorCatalog = createSearchOperatorRegistry(store).forkForRun();
    const tools = createPicorerTools({
      store,
      operatorRegistry: operatorCatalog,
      operatorDefinitions: operatorCatalog,
      scopeId: "compact-scope",
      ledger: new MemoryLedger("compact-scope"),
      maxSearchCalls: 4,
      interfaceMode: "compact",
    });

    expect(tools.all.map((tool) => tool.name)).toEqual([
      "search",
      "search_more",
      "define_operator",
      "read",
      "finish",
    ]);
    expect(Object.keys(tools.search.parameters.properties!)).toEqual([
      "workingMemory",
      "operator",
      "queries",
      "branches",
      "combine",
      "order",
      "maxPerSession",
      "limit",
    ]);
    expect(Object.keys(tools.read.parameters.properties!)).toEqual([
      "candidateRefs",
    ]);
    expect(Object.keys(tools.finish.parameters.properties!)).toEqual(["status"]);
    expect(tools.search.description).toContain("id=hybrid");
    expect(tools.search.description).toContain("id=lexical");

    const first = await tools.search.execute("search-1", {
      operator: "hybrid",
      queries: ["Fact"],
      branches: [{ operator: "lexical", queries: ["Fact 30"] }],
      combine: "union",
    });
    expect(semanticSearches).toBe(1);
    expect(lexicalSearches).toBe(1);
    expect(first.details.composition?.steps.map((step) => step.kind)).toEqual([
      "search",
      "search",
      "combine",
    ]);
    const firstText = JSON.stringify(first.content);
    expect(firstText).toContain("Current search results");
    expect(firstText).toContain("read C1");
    expect(firstText).toContain("read C20");
    expect(firstText).not.toContain("read C21");
    expect(firstText).not.toContain("Latest retrieval frontier");
    expect(firstText).not.toContain("Caller question");
    expect(firstText).toContain(
      "decide from the acquired evidence whether to search again or finish",
    );
    expect(firstText).not.toContain("cover the question");

    const second = await tools.searchMore.execute("more-1", {});
    const secondText = JSON.stringify(second.content);
    expect(secondText).toContain("read C21");
    expect(secondText).toContain("read C30");
  });

  it("uses no neighboring turns and retains the complete parent when it fits", async () => {
    const long = source(
      1,
      `${"irrelevant context ".repeat(2_000)}The requested compact fact is here.`,
    );
    let context: {
      before: number | undefined;
      after: number | undefined;
    } | undefined;
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return [{
          record: long,
          query: request.queries[0]!,
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: "The requested compact fact is here.",
        }];
      },
      read(_scopeId, _memoryIds, before, after) {
        context = { before, after };
        return [long];
      },
    };
    const ledger = new MemoryLedger("compact-scope");
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "compact-scope",
      ledger,
      interfaceMode: "compact",
    });
    const search = await tools.search.execute("search-1", {
      queries: ["requested compact fact"],
    });
    expect(search.details.candidates[0]?.passage).toMatchObject({
      parentMemoryId: "m1",
    });
    const result = await tools.read.execute("read-1", {
      candidateRefs: ["C1"],
    });

    expect(context).toEqual({ before: 0, after: 0 });
    expect(result.details.contextBefore).toBe(0);
    expect(result.details.contextAfter).toBe(0);
    expect(JSON.stringify(result.content)).not.toContain(long.content);
    expect(JSON.stringify(result.content)).toContain(
      "The requested compact fact is here.",
    );
    expect(ledger.inspectedEvidence[0]?.content).toBe(long.content);
    expect(result.details.evidence[0]?.truncated).toBe(false);
  });

  it("keeps the selected exact passage when its parent exceeds the compact read budget", async () => {
    const target = "The oversized parent still contains this exact fact.";
    const long = source(1, `${"head ".repeat(14_000)}${target}${" tail".repeat(14_000)}`);
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return [{ record: long, query: request.queries[0]!, retriever: "fts5", rank: 1, score: 1, preview: target }];
      },
      read() {
        return [long];
      },
    };
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "compact-scope",
      ledger: new MemoryLedger("compact-scope"),
      interfaceMode: "compact",
    });
    await tools.search.execute("search-1", { queries: ["oversized exact fact"] });
    const result = await tools.read.execute("read-1", { candidateRefs: ["C1"] });

    expect(result.details.evidence[0]?.truncated).toBe(true);
    expect(JSON.stringify(result.content)).toContain(target);
    expect(result.details.evidence[0]!.excerpts.some((excerpt) =>
      excerpt.start <= long.content.indexOf(target) &&
      excerpt.end >= long.content.indexOf(target) + target.length
    )).toBe(true);
  });

  it("keeps a bounded set of unread candidates actionable after later actions", async () => {
    const records = [source(1, "first candidate"), source(2, "second candidate")];
    let search = 0;
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        const record = records[search++]!;
        return [{ record, query: request.queries[0]!, retriever: "fts5", rank: 1, score: 1, preview: record.content }];
      },
      read(_scopeId, memoryIds) {
        return records.filter((record) => memoryIds.includes(record.memoryId));
      },
    };
    const ledger = new MemoryLedger("compact-scope");
    const context = createWorkingMemoryContext(ledger, undefined, "rewrite", true);
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "compact-scope",
      ledger,
      observation: context.observation,
      interfaceMode: "compact",
    });

    await tools.search.execute("search-1", { queries: ["first"] });
    const second = await tools.search.execute("search-2", { queries: ["second"] });
    expect(JSON.stringify(second.content)).toContain("Still-readable candidates from an earlier search");
    expect(JSON.stringify(second.content)).toContain("read C1");
    const read = await tools.read.execute("read-2", { candidateRefs: ["C2"] });
    expect(JSON.stringify(read.content)).toContain("Still-readable candidates from recent searches");
    expect(JSON.stringify(read.content)).toContain("read C1");
  });

  it("keeps semantic parent reads complete when a six-parent batch fits 128 KiB", async () => {
    const records = Array.from({ length: 6 }, (_, index) => source(
      index + 1,
      `${`Distractor ${String(index)}. `.repeat(900)}` +
        (index === 4 ? "The exact middle-hop fact is preserved. " : "") +
        `${`Tail ${String(index)}. `.repeat(300)}`,
    ));
    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return records.map((record, index) => ({
          record,
          query: request.queries[0]!,
          retriever: "picorer-hybrid",
          rank: index + 1,
          score: 1 / (index + 1),
          preview: "Semantic parent match without a lexical source location.",
        }));
      },
      read(_scopeId, memoryIds) {
        return records.filter((record) => memoryIds.includes(record.memoryId));
      },
    };
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "compact-scope",
      ledger: new MemoryLedger("compact-scope"),
      interfaceMode: "compact",
    });
    const search = await tools.search.execute("search-1", {
      queries: ["unseen semantic relation"],
    });
    expect(search.details.candidates.every(candidate =>
      candidate.passage === undefined
    )).toBe(true);
    const result = await tools.read.execute("read-1", {
      candidateRefs: ["C1", "C2", "C3", "C4", "C5", "C6"],
    });

    expect(result.details.evidence).toHaveLength(6);
    expect(result.details.evidence.every(evidence => !evidence.truncated)).toBe(
      true,
    );
    expect(JSON.stringify(result.content)).toContain(
      "The exact middle-hop fact is preserved.",
    );
  });
});
