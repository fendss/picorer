import { describe, expect, it } from "vitest";
import { buildAggregateOperatorResult } from "../src/retrieval/operators/numeric-operator.js";
import {
  buildTimelineOperatorResult,
  resolveTemporalQuestion,
  temporalAuxiliaryRequest,
} from "../src/retrieval/operators/temporal-operator.js";
import type { StoreSearchHit } from "../src/platform/sqlite/picorer-store.js";
import type { MemoryRecord } from "../src/memory/index.js";
import type { SearchRequest } from "../src/retrieval/index.js";

function hit(
  memoryId: string,
  content: string,
  timestamp: string,
  options: { sessionId?: string; role?: MemoryRecord["role"]; query?: string } = {},
): StoreSearchHit {
  const record: MemoryRecord = {
    memoryId,
    scopeId: "scope-1",
    sessionId: options.sessionId ?? `session-${memoryId}`,
    turnIndex: 0,
    role: options.role ?? "user",
    content,
    timestamp,
    contentHash: `hash-${memoryId}`,
    metadata: {},
  };
  return {
    record,
    query: options.query ?? "source",
    retriever: "picorer-hybrid",
    rank: 1,
    score: 1,
    preview: content,
  };
}

describe("timeline evidence operator", () => {
  it("resolves relative dates against the question date and creates a bounded request", () => {
    const plan = resolveTemporalQuestion(
      "Now is 2023/03/25 (Sat) 18:26. What kitchen appliance did I buy 10 days ago?",
      "2023/03/25 (Sat) 18:26",
    );
    expect(plan.targets).toEqual([{
      expression: "10 days ago",
      date: "2023-03-15",
      basis: "relative-to-question",
    }]);

    const request: SearchRequest = {
      queries: ["kitchen appliance purchase"],
      limit: 20,
      order: "relevance",
      maxPerSession: 4,
    };
    expect(temporalAuxiliaryRequest(request, plan)).toEqual({
      ...request,
      after: "2023-03-15T00:00:00",
      before: "2023-03-15T23:59:59.999",
      order: "chronological",
    });
    expect(temporalAuxiliaryRequest({
      ...request,
      before: "2023-03-15T18:26:00Z",
    }, plan)).toMatchObject({
      after: "2023-03-15T00:00:00",
      before: "2023-03-15T18:26:00Z",
      order: "chronological",
    });
  });

  it("returns chronological source-grounded rows", () => {
    const result = buildTimelineOperatorResult(
      [
        hit("m-late", "The second event happened.", "2023-03-15T10:00:00"),
        hit("m-early", "The first event happened.", "2023-03-01T10:00:00"),
      ],
      "Which event happened first?",
      "2023/03/25 (Sat) 18:26",
    );
    expect(result.operator).toBe("temporal");
    expect(result.rows.map((row) => row.memoryId)).toEqual(["m-early", "m-late"]);
    expect(result.rows[0]).toMatchObject({ eventTime: "2023-03-01" });
  });

  it("surfaces resolved sidecar dates with the source row", () => {
    const source = hit(
      "m-relative",
      "I ordered the replacement two days ago.",
      "2023-03-20T10:00:00",
    );
    source.operatorTemporalFacts = [{
      expression: "two days ago",
      resolvedDate: "2023-03-18",
      basis: "relative-to-memory",
    }];

    const result = buildTimelineOperatorResult(
      [source],
      "When did I order the replacement?",
      "2023/03/25 (Sat) 18:26",
    );

    expect(result.rows[0]).toMatchObject({
      eventTime: "2023-03-20",
      mentionedDates: ["2023-03-18"],
    });
  });
});

describe("aggregate evidence operator", () => {
  it("extracts and classifies source quantities without proposing an unchecked total", () => {
    const result = buildAggregateOperatorResult([
      hit("m-herbs", "I earned a total of $120 selling herbs.", "2023-05-01T10:00:00"),
      hit("m-jam", "I earned $225 selling jam.", "2023-05-08T10:00:00"),
      hit("m-plants", "I sold 20 potted plants for $7.5 each.", "2023-05-15T10:00:00"),
      hit("m-target", "I hope to earn $500 next time.", "2023-05-20T10:00:00"),
    ]);
    expect(result.operator).toBe("numeric");
    expect(result.rows.map((row) => row.valueKind)).toEqual([
      "increment",
      "increment",
      "increment",
      "target",
    ]);
    expect(result.rows.map((row) => row.value)).toEqual([120, 225, 150, 500]);
    expect(result.derived).toMatchObject({ excludedTargetCount: 1 });
    expect(result.derived).not.toHaveProperty("proposedTotal");
  });

  it("uses the latest cumulative snapshot instead of summing snapshots", () => {
    const result = buildAggregateOperatorResult([
      hit("m-old", "I have earned $300 so far.", "2023-05-01T10:00:00"),
      hit("m-new", "I have earned $450 so far.", "2023-05-20T10:00:00"),
    ]);
    expect(result.derived).toMatchObject({
      latestCumulativeOrSnapshot: 450,
      latestUnit: "USD",
      latestMemoryId: "m-new",
    });
    expect(result.derived).not.toHaveProperty("proposedTotal");
  });
});
