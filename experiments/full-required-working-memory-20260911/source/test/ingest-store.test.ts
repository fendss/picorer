import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestMemorySessions } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import type { MemorySessionInput } from "../src/memory/index.js";

const temporaryPaths: string[] = [];

async function temporaryStore(): Promise<{
  root: string;
  store: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "picorer-test-"));
  temporaryPaths.push(root);
  return {
    root,
    store: await MemoryStore.create(join(root, "memory.sqlite")),
  };
}

function sessions(content = "I adopted a cat named Miso."): MemorySessionInput[] {
  return [
    {
      scopeId: "scope-1",
      sessionId: "session-1",
      timestamp: "2024-01-02T03:04:00",
      metadata: { sourceSessionId: "session_1" },
      turns: [
        {
          id: "m-000000000000000000000001",
          role: "user",
          content,
          metadata: { sourceDiaId: "S1:1" },
        },
        {
          id: "m-000000000000000000000002",
          role: "assistant",
          content: "Miso sounds lovely.",
        },
      ],
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("deterministic ingest and source store", () => {
  it.each(["memory.jsonl", "unexpected.txt"])("refuses to reuse an export containing a changed or extra %s", async (file) => {
    const { root, store } = await temporaryStore();
    try {
      await ingestMemorySessions(store, sessions());
      const exportRoot = join(root, "sanitized");
      const published = await store.exportScope("scope-1", exportRoot);
      await expect(store.exportScope("scope-1", exportRoot)).resolves.toEqual(published);
      await writeFile(join(published.path, file), "unrelated source content");
      await expect(store.exportScope("scope-1", exportRoot)).rejects.toThrow("does not match");
      expect(await readFile(join(published.path, file), "utf8")).toBe("unrelated source content");
      expect((await readdir(exportRoot)).some((name) => name.startsWith(".scope-"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("indexes exact source text and exports a bash-visible corpus", async () => {
    const { root, store } = await temporaryStore();
    try {
      const [result] = await ingestMemorySessions(store, sessions(), {
        exportRoot: join(root, "sanitized"),
      });
      expect(result).toMatchObject({
        scopeId: "scope-1",
        status: "inserted",
        memoryCount: 2,
      });

      const hits = store.search("scope-1", {
        queries: ["cat Miso"],
        limit: 5,
      });
      expect(hits[0]?.record.content).toBe("I adopted a cat named Miso.");
      const multiQueryHit = store.search("scope-1", {
        queries: ["cat Miso", "adopted Miso"],
        limit: 5,
      }).find((hit) =>
        hit.record.memoryId === "m-000000000000000000000001"
      );
      expect(multiQueryHit?.matchedQueries).toEqual([
        "cat Miso",
        "adopted Miso",
      ]);
      const assistantHits = store.search("scope-1", {
        queries: ["Miso"],
        roles: ["assistant"],
        limit: 5,
      });
      expect(assistantHits.map((hit) => hit.record.content)).toEqual([
        "Miso sounds lovely.",
      ]);

      const read = store.read(
        "scope-1",
        ["m-000000000000000000000001"],
        0,
        1,
      );
      expect(read.map((record) => record.memoryId)).toEqual([
        "m-000000000000000000000001",
        "m-000000000000000000000002",
      ]);

      const memoryJsonl = await readFile(
        join(result?.exportPath ?? "", "memory.jsonl"),
        "utf8",
      );
      expect(memoryJsonl).toContain("I adopted a cat named Miso.");
      expect(memoryJsonl).toContain("m-000000000000000000000001");
    } finally {
      store.close();
    }
  });

  it("makes identical re-ingest a no-op and rejects source mutation", async () => {
    const { store } = await temporaryStore();
    try {
      const first = await ingestMemorySessions(store, sessions());
      const second = await ingestMemorySessions(store, sessions());
      expect(first[0]?.status).toBe("inserted");
      expect(second[0]?.status).toBe("unchanged");

      await expect(
        ingestMemorySessions(store, sessions("Changed source text.")),
      ).rejects.toThrow(/immutable memory scope/iu);
      expect(
        store.getRecords("scope-1", ["m-000000000000000000000001"])[0]
          ?.content,
      ).toBe("I adopted a cat named Miso.");
    } finally {
      store.close();
    }
  });

  it("preserves domain metadata without knowing benchmark vocabulary", async () => {
    const { store } = await temporaryStore();
    const input = sessions();
    input[0]!.turns[0]!.metadata = {
      answer: "A legitimate field in a caller-owned domain",
    };
    try {
      await ingestMemorySessions(store, input);
      expect(
        store.getRecords("scope-1", ["m-000000000000000000000001"])[0]
          ?.metadata,
      ).toMatchObject({
        turn: { answer: "A legitimate field in a caller-owned domain" },
      });
    } finally {
      store.close();
    }
  });

  it("preserves source-addressable empty turns", async () => {
    const { store } = await temporaryStore();
    const input = sessions("");
    try {
      await ingestMemorySessions(store, input);
      expect(
        store.getRecords("scope-1", ["m-000000000000000000000001"])[0]
          ?.content,
      ).toBe("");
    } finally {
      store.close();
    }
  });

  it("uses informative anchors instead of matching query stopwords", async () => {
    const { store } = await temporaryStore();
    const input: MemorySessionInput[] = [
      {
        scopeId: "scope-1",
        sessionId: "session-unrelated",
        turns: [{
          id: "m-200000000000000000000001",
          role: "user",
          content: "An unrelated gardening note.",
        }],
      },
      {
        scopeId: "scope-1",
        sessionId: "session-shirt",
        turns: [{
          id: "m-200000000000000000000002",
          role: "user",
          content: "I bought a simple white shirt.",
        }],
      },
      {
        scopeId: "scope-1",
        sessionId: "session-headphones",
        turns: [{
          id: "m-200000000000000000000003",
          role: "user",
          content: "I recently got a new pair of Sony headphones. The headphones cost $378.",
        }],
      },
    ];
    try {
      await ingestMemorySessions(store, input);

      const purchase = store.search("scope-1", {
        queries: ["I bought an iPad"],
        limit: 5,
      });
      const exactProduct = store.search("scope-1", {
        queries: ["new pair Sony headphones"],
        limit: 5,
      });

      expect(purchase.map((item) => item.record.memoryId)).toEqual([
        "m-200000000000000000000002",
      ]);
      expect(exactProduct[0]?.record.memoryId).toBe(
        "m-200000000000000000000003",
      );
    } finally {
      store.close();
    }
  });

  it("expands timeline and aggregate evidence from versioned database facts", async () => {
    const { store } = await temporaryStore();
    const input: MemorySessionInput[] = [
      {
        scopeId: "scope-1",
        sessionId: "session-target-date",
        timestamp: "2024-01-10T09:00:00",
        turns: [{
          id: "m-100000000000000000000001",
          role: "user",
          content: "I bought a smoker for the kitchen.",
        }],
      },
      {
        scopeId: "scope-1",
        sessionId: "session-market-one",
        timestamp: "2024-01-20T09:00:00",
        turns: [{
          id: "m-100000000000000000000002",
          role: "user",
          content: "At the market I earned a total of $120 from sales.",
        }],
      },
      {
        scopeId: "scope-1",
        sessionId: "session-market-two",
        timestamp: "2024-01-21T09:00:00",
        turns: [
          {
            id: "m-100000000000000000000003",
            role: "user",
            content: "At the market I sold 20 plants for $7.5 each.",
          },
          {
            id: "m-100000000000000000000004",
            role: "user",
            content: "Offer 10 loyalty points for every $50 spent.",
          },
        ],
      },
    ];
    try {
      await ingestMemorySessions(store, input);
      const seed = store.search("scope-1", {
        queries: ["market sales"],
        limit: 1,
      });
      const timelineSeed = store.search("scope-1", {
        queries: ["kitchen appliance"],
        limit: 1,
      });
      const timeline = store.expandEvidenceOperator(
        "scope-1",
        { queries: ["kitchen appliance"], limit: 1 },
        {
          operator: "temporal",
          maxCandidates: 20,
        },
        timelineSeed,
      );
      expect(timeline.map((hit) => hit.record.memoryId)).toContain(
        "m-100000000000000000000001",
      );
      expect(timeline[0]?.retriever).toBe("picorer-timeline-db");
      expect(timeline[0]?.record.memoryId).toBe("m-100000000000000000000001");
      const targetDateTimeline = store.expandEvidenceOperator(
        "scope-1",
        { queries: ["unknown source wording"], limit: 1 },
        {
          operator: "temporal",
          maxCandidates: 20,
          targetDates: ["2024-01-10"],
        },
        [],
      );
      expect(targetDateTimeline[0]).toMatchObject({
        record: { memoryId: "m-100000000000000000000001" },
        query: "database timeline dates 2024-01-10",
      // The context date admits this source; the text query did not match it.
      matchedQueries: [],
        operatorTemporalFacts: [expect.objectContaining({
          resolvedDate: "2024-01-10",
        })],
      });

      const aggregate = store.expandEvidenceOperator(
        "scope-1",
        { queries: ["market sales"], limit: 1 },
        {
          operator: "numeric",
          maxCandidates: 20,
        },
        seed,
      );
      expect(aggregate.map((hit) => hit.record.memoryId)).toEqual(
        expect.arrayContaining([
          "m-100000000000000000000002",
          "m-100000000000000000000003",
        ]),
      );
      expect(aggregate.map((hit) => hit.record.memoryId)).not.toContain(
        "m-100000000000000000000004",
      );
      expect(aggregate.every((hit) => hit.retriever === "picorer-aggregate-db"))
        .toBe(true);
      expect(aggregate.every((hit) =>
        (hit.operatorSourceSpans?.length ?? 0) > 0 &&
        hit.operatorSourceSpans!.every((span) =>
          hit.record.content.slice(span.start, span.end).length > 0
        )
      )).toBe(true);
      expect(aggregate.every((hit) =>
        hit.query === "database numeric facts for market sales" &&
        JSON.stringify(hit.matchedQueries) === JSON.stringify(["market sales"])
      )).toBe(true);

      const firstStatus = store.ensureEvidenceFactIndex("scope-1");
      const secondStatus = store.ensureEvidenceFactIndex("scope-1");
      expect(firstStatus).toEqual(secondStatus);
      expect(firstStatus).toMatchObject({
        indexedMemories: 4,
        numericFacts: 3,
        temporalFacts: 4,
      });
    } finally {
      store.close();
    }
  });
});
