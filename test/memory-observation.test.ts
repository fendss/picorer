import { describe, expect, it } from "vitest";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import {
  createPicorerTools,
  MemoryLedger,
} from "../src/evidence-agent/index.js";
import { createMemoryObservation } from "../src/evidence-agent/adapters/pi/memory-observation.js";
import type { MemoryToolStore } from "../src/evidence-agent/adapters/pi/tools.js";
import type { MemoryRecord } from "../src/memory/index.js";
import type { SearchRequest } from "../src/retrieval/index.js";

function memory(
  memoryId: string,
  sessionId: string,
  role: "user" | "assistant",
  timestamp: string,
  content: string,
): MemoryRecord {
  return {
    memoryId,
    scopeId: "observation-replay",
    sessionId,
    turnIndex: 0,
    role,
    timestamp,
    content,
    contentHash: `hash-${memoryId}`,
    metadata: {},
  };
}

describe("memory observation", () => {
  it("keeps two passage candidates from one parent independently actionable", () => {
    const parent = memory(
      "shared-parent",
      "shared-session",
      "user",
      "2023-05-19T10:00:00",
      "The first passage establishes Alpha. The second passage establishes Omega.",
    );
    const alpha = "The first passage establishes Alpha.";
    const omega = "The second passage establishes Omega.";
    const omegaStart = parent.content.indexOf(omega);
    const hits = [
      {
        record: parent,
        query: "Alpha",
        retriever: "picorer-hybrid",
        rank: 1,
        score: 1,
        preview: alpha,
        passage: {
          passageId: "passage-alpha",
          parentMemoryId: parent.memoryId,
          sourceContentHash: parent.contentHash,
          index: 0,
          start: 0,
          end: alpha.length,
          content: alpha,
        },
      },
      {
        record: parent,
        query: "Omega",
        retriever: "picorer-hybrid",
        rank: 2,
        score: 0.9,
        preview: omega,
        passage: {
          passageId: "passage-omega",
          parentMemoryId: parent.memoryId,
          sourceContentHash: parent.contentHash,
          index: 1,
          start: omegaStart,
          end: omegaStart + omega.length,
          content: omega,
        },
      },
    ] as const;
    const ledger = new MemoryLedger("observation-replay");
    const findings = ledger.recordSearchHits(hits);
    const observation = createMemoryObservation({
      ledger,
      question: "What do Alpha and Omega establish?",
      maxSearchCalls: 2,
    });
    observation.recordSearch({ findingCount: findings.length, findings });

    const rendered = observation.render();
    expect(rendered).toContain("Uninspected findings: 2 across 1 separate conversation.");
    expect(rendered).toContain("read C1");
    expect(rendered).toContain("read C2");
    expect(rendered).toContain(alpha);
    expect(rendered).toContain(omega);
  });

  it("shows an inspect payload once, keeps only an E receipt, and preserves older candidates", async () => {
    const records = {
      bulb: memory(
        "bulb",
        "lighting",
        "user",
        "2023-03-01T20:00:00",
        "I've been using a Philips LED bulb in my bedside lamp.",
      ),
      yoga: memory(
        "yoga",
        "fitness-yoga",
        "user",
        "2023-03-08T09:00:00",
        "I recently started a yoga class on Wednesdays.",
      ),
      fitness: memory(
        "fitness",
        "fitness-other",
        "user",
        "2023-03-10T09:00:00",
        "I attend Zumba on Tuesdays and Thursdays and lift weights on Saturdays.",
      ),
      yogaDetail: memory(
        "yoga-detail",
        "fitness-yoga",
        "assistant",
        "2023-03-08T09:00:00",
        "The Wednesday yoga class is a separate weekly fitness day.",
      ),
      genericRecipe: memory(
        "generic-recipe",
        "slow-cooker",
        "assistant",
        "2023-03-12T12:00:00",
        "You could try a generic vegetarian slow-cooker recipe.",
      ),
      beefStew: memory(
        "beef-stew",
        "slow-cooker",
        "user",
        "2023-03-12T11:59:00",
        "I made a delicious beef stew after learning to use the slow cooker.",
      ),
      bedtime: memory(
        "bedtime",
        "doctor-visit",
        "user",
        "2023-03-16T08:00:00",
        "I didn't get to bed until 2 AM last Wednesday.",
      ),
    } as const;
    const byQuery: Record<string, MemoryRecord[]> = {
      bulb: [records.bulb],
      fitness: [records.yoga, records.fitness, records.yogaDetail],
      "slow cooker": [records.genericRecipe, records.beefStew],
      bedtime: [records.bedtime],
    };
    const store: MemoryToolStore = {
      search(_scopeId: string, request: SearchRequest) {
        return request.queries.flatMap((query) =>
          (byQuery[query] ?? []).map((record, index) => ({
            record,
            query,
            retriever: "picorer-hybrid",
            rank: index + 1,
            score: 1 / (index + 1),
            preview: record.content,
          }))
        );
      },
      read(_scopeId, memoryIds) {
        return Object.values(records).filter((record) =>
          memoryIds.includes(record.memoryId)
        );
      },
    };
    const ledger = new MemoryLedger("observation-replay");
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "observation-replay",
      ledger,
      maxSearchCalls: 4,
      question: "What weekly fitness events and bedtime did the user report?",
      questionDate: "2023/03/20 (Mon) 12:00",
    });

    await tools.search.execute("search-bulb", {
      workingMemory: "Need direct evidence for the requested fact.",
      queries: ["bulb"],
    });
    const firstInspect = await tools.read.execute("read-bulb", {
      workingMemory: "The bulb source is unrelated; the requested fact remains missing.",
      candidateRefs: ["C1"],
    });
    expect(JSON.stringify(firstInspect.content)).toContain("<READ_RESULT>");
    expect(JSON.stringify(firstInspect.content)).toContain("Philips LED bulb");
    await tools.search.execute("search-fitness", {
      workingMemory: "Find all distinct fitness events; the bulb is unrelated.",
      queries: ["fitness"],
    });
    await tools.search.execute("search-slow-cooker", {
      queries: ["slow cooker"],
    });
    const finalSearch = await tools.search.execute("search-bedtime", {
      queries: ["bedtime"],
    });
    const observation = JSON.stringify(finalSearch.content);

    const needIndex = observation.indexOf("Need");
    const inspectedIndex = observation.indexOf("Inspected evidence ledger");
    const uninspectedIndex = observation.indexOf("Uninspected candidates");
    expect(needIndex).toBeGreaterThan(-1);
    expect(inspectedIndex).toBeGreaterThan(needIndex);
    expect(uninspectedIndex).toBeGreaterThan(inspectedIndex);
    expect(observation).toContain("Caller question");
    expect(observation).toContain(
      "What weekly fitness events and bedtime did the user report?",
    );
    expect(observation).toContain(
      "Model working state (confirmed facts and unresolved needs)",
    );
    expect(observation).toContain("Searches remaining: 0");
    expect(observation).toContain("Uninspected findings: 6 across 4 separate conversations.");
    expect(observation).toContain("Inspected evidence ledger");
    expect(observation).toContain("evidence E1");
    expect(observation).toContain("inspected from C1");
    expect(observation).not.toContain("Philips LED bulb");
    expect(observation).toContain("Latest uninspected findings");
    expect(observation).toContain(
      "Active findings from the most recent search (top 20 maximum):",
    );
    expect(observation).toContain("2 AM last Wednesday");
    expect(observation).toContain("User");
    expect(observation).toContain("2023-03-16T08:00:00");
    expect(observation).toContain("Earlier uninspected directory");
    expect(observation).toContain("new search is not required to recover them");
    expect(observation).toContain("read C2");
    expect(observation).toContain("yoga class on Wednesdays");
    expect(observation).toContain("generic vegetarian slow-cooker recipe");
    expect(observation).toContain("Find all distinct fitness events");
    expect(observation).toContain("Latest retrieval frontier");
    expect(observation).not.toContain("sessionId");
    expect(observation).not.toContain("matched_query");
    expect(observation).not.toContain("candidate_refs");
  });

  it("promotes a later exact semantic hit and exposes its query-centered preview", async () => {
    const distractor = memory(
      "distractor",
      "planning",
      "user",
      "2023-05-28T03:42:00",
      "I am planning several projects and discussing their timelines.",
    );
    const ledProject = memory(
      "led-project",
      "marketing",
      "user",
      "2023-05-21T19:38:00",
      "I worked on customer research and, in my Marketing Research class project, I led the data analysis team.",
    );
    const store: MemoryToolStore = {
      search(_scopeId: string, request: SearchRequest) {
        if (request.queries.includes("projects")) {
          return [
            {
              record: distractor,
              query: "projects",
              retriever: "picorer-hybrid",
              rank: 1,
              score: 1,
              preview: distractor.content,
            },
            {
              record: ledProject,
              query: "projects",
              retriever: "picorer-hybrid",
              rank: 20,
              score: 0.05,
              preview: "I worked on customer research and a Marketing Research class project …",
            },
          ];
        }
        return [{
          record: ledProject,
          query: "I led the",
          retriever: "fts5",
          rank: 1,
          score: 1,
          preview: "… in my Marketing Research class project, I led the data analysis team.",
        }];
      },
      read(_scopeId, memoryIds) {
        return [distractor, ledProject].filter((record) =>
          memoryIds.includes(record.memoryId)
        );
      },
    };
    const ledger = new MemoryLedger("observation-replay");
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "observation-replay",
      ledger,
      maxSearchCalls: 4,
    });

    await tools.search.execute("broad", {
      operator: "hybrid",
      queries: ["projects"],
    });
    const focused = await tools.search.execute("focused", {
      operator: "lexical",
      queries: ["I led the"],
    });
    const observation = JSON.stringify(focused.content);

    expect(observation).toContain(
      "Active findings from the most recent search (top 20 maximum):",
    );
    expect(observation).toContain(
      "Marketing Research class project, I led the data analysis team",
    );
    expect(observation).toContain("Earlier uninspected directory");
    expect(observation).toContain("read C1");
    expect(observation).toContain("planning several projects");
    expect(ledger.selectMemoryCandidates([ledProject.memoryId]).some((candidate) =>
      candidate.memoryId === ledProject.memoryId &&
      candidate.preview.includes("I led the data analysis team")
    )).toBe(true);

    const inspected = await tools.read.execute("read-focused", {
      candidateRefs: ["C2"],
    });
    const afterInspect = JSON.stringify(inspected.content);
    expect(afterInspect).toContain("<READ_RESULT>");
    expect(afterInspect).toContain("I led the data analysis team");
    expect(afterInspect).toContain("evidence E1");
    expect(afterInspect).toContain("inspected from C2");
  });

  it("does not hide an answer-bearing tail when rendering bounded previews", async () => {
    const queryCenteredPreview =
      `${"The discussion covered camera techniques and narrative structure. ".repeat(4)}` +
      "I spoke with the director after the screening at the " +
      "Seattle International Film Festival.";
    const middleEntityPreview =
      `${"Background details without the requested entity. ".repeat(3)}` +
      "At the festival I attended the Northern Systems Research Symposium in person. " +
      `${"Unrelated follow-up discussion continued afterward. ".repeat(3)}`;
    const festival = memory(
      "festival-tail",
      "film-session",
      "user",
      "2023-05-21T17:55:00",
      queryCenteredPreview,
    );
    const later = memory(
      "later-result",
      "other-session",
      "user",
      "2023-05-22T10:00:00",
      "A later unrelated result.",
    );
    const symposium = memory(
      "symposium-middle",
      "research-session",
      "user",
      "2023-05-20T09:00:00",
      middleEntityPreview,
    );
    expect(queryCenteredPreview.length).toBeGreaterThan(280);
    expect(queryCenteredPreview.length).toBeLessThanOrEqual(360);
    expect(middleEntityPreview.length).toBeGreaterThan(160);
    expect(middleEntityPreview.indexOf("Northern Systems")).toBeGreaterThan(80);
    expect(
      middleEntityPreview.length - middleEntityPreview.indexOf("Symposium"),
    ).toBeGreaterThan(80);

    const store: MemoryToolStore = {
      search(_scopeId, request) {
        return request.queries.includes("festival")
          ? [
              {
                record: festival,
                query: "film festival",
                retriever: "picorer-hybrid",
                rank: 18,
                score: 0.05,
                preview: queryCenteredPreview,
              },
              {
                record: symposium,
                query: "festival",
                retriever: "picorer-hybrid",
                rank: 19,
                score: 0.04,
                preview: middleEntityPreview,
              },
            ]
          : [{
              record: later,
              query: "later",
              retriever: "picorer-hybrid",
              rank: 1,
              score: 1,
              preview: later.content,
            }];
      },
      read(_scopeId, memoryIds) {
        return [festival, symposium, later].filter((record) =>
          memoryIds.includes(record.memoryId)
        );
      },
    };
    const ledger = new MemoryLedger("observation-replay");
    const tools = createPicorerTools({
      store,
      operatorRegistry: createSearchOperatorRegistry(store),
      scopeId: "observation-replay",
      ledger,
      maxSearchCalls: 4,
    });

    const active = await tools.search.execute("festival", {
      queries: ["festival"],
    });
    expect(JSON.stringify(active.content)).toContain(
      "Seattle International Film Festival",
    );
    expect(JSON.stringify(active.content)).toContain(
      "Northern Systems Research Symposium",
    );

    const movedToDirectory = await tools.search.execute("later", {
      queries: ["later"],
    });
    const rendered = JSON.stringify(movedToDirectory.content);
    expect(rendered).toContain("Earlier uninspected directory");
    expect(rendered).toContain("Seattle International Film Festival");
    expect(rendered).toContain("Northern Systems Research Symposium");
    expect(rendered).toContain("read C1");
    expect(rendered).toContain("read C2");
  });
});
