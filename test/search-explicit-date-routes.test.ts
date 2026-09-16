import { describe, expect, it, vi } from "vitest";
import { searchExplicitDateRoutes } from "../src/retrieval/search-explicit-date-routes.js";
import type { DenseRetriever, DenseSearchBatchRequest, DenseSearchHit } from "../src/retrieval/ports/dense-retriever.js";

const base: DenseSearchBatchRequest = {
  scopeId: "scope-a",
  profile: { profileId: "profile", model: "test", dimensions: 2 },
  queryVectors: [[1, 0], [0, 1], [1, 1]],
  limit: 100,
  filters: { roles: ["user"], sessionIds: ["session-a"] },
};
function retriever(search: DenseRetriever["search"]): DenseRetriever {
  return { retrievalProfile: "picorer-hybrid", search };
}

describe("explicit-date dense batching", () => {
  it("batches equal windows, separates dates, and maps each ranking to its own query", async () => {
    const answers: DenseSearchHit[][] = [[], [], []];
    const search = vi.fn(async (request: DenseSearchBatchRequest) =>
      request.queryVectors.map((vector) => answers[base.queryVectors.indexOf(vector)]!)
    );
    const signal = new AbortController().signal;
    const routes = searchExplicitDateRoutes(retriever(search), { ...base, signal }, [
      "left 2024-03-01", "middle 2024-04-01", "right 2024/03/01",
    ]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]![0]).toEqual({
      ...base, signal, queryVectors: [base.queryVectors[0], base.queryVectors[2]],
      filters: { ...base.filters, after: "2024-03-01T00:00:00", before: "2024-03-01T23:59:59.999" },
    });
    for (const index of [0, 1, 2]) expect(await routes.get(index)!.ranking).toBe(answers[index]);
    expect(routes.get(2)!.filter.query).toBe("right 2024/03/01");
  });

  it("does not infer relative, ambiguous or malformed dates, or override explicit filters", () => {
    const search = vi.fn(async () => []);
    const dense = retriever(search);
    expect(searchExplicitDateRoutes(dense, base, [
      "last month", "2024-03-01 through 2024-04-01", "2024-02-30",
    ]).size).toBe(0);
    for (const filters of [{ after: "2024-01-01" }, { before: "2024-12-31" }]) {
      expect(searchExplicitDateRoutes(dense, { ...base, filters }, ["2024-03-01"]).size).toBe(0);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects incomplete batch rankings instead of treating them as empty retrieval", async () => {
    const routes = searchExplicitDateRoutes(retriever(async () => [[]]), base, [
      "left 2024-03-01", "right 2024-03-01",
    ]);
    const results = await Promise.allSettled([...routes.values()].map((route) => route.ranking));
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected"
      && result.reason.message === "Date dense ranking count does not match query count")).toBe(true);
  });

  it("propagates a failed dense batch to all of its query paths", async () => {
    const error = new Error("backend unavailable");
    const routes = searchExplicitDateRoutes(retriever(async () => { throw error; }), base, [
      "left 2024-03-01", "right 2024-03-01",
    ]);
    const results = await Promise.allSettled([...routes.values()].map((route) => route.ranking));
    expect(results.every((result) => result.status === "rejected" && result.reason === error)).toBe(true);
  });
});
