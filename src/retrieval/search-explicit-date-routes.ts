import type { DenseRetriever, DenseSearchBatchRequest, DenseSearchHit } from "./ports/dense-retriever.js";
import type { RetrievalMetadataFilter } from "./model/search.js";
import { explicitQueryDateFilter } from "./structured-query-constraints.js";

interface DateRoute {
  filter: RetrievalMetadataFilter;
  ranking: Promise<readonly DenseSearchHit[]>;
}

/** Batch equal calendar windows without merging query votes or provenance. */
export function searchExplicitDateRoutes(
  dense: DenseRetriever,
  base: DenseSearchBatchRequest,
  queries: readonly string[],
): Map<number, DateRoute> {
  const routes = new Map<number, DateRoute>();
  if (base.filters?.after !== undefined || base.filters?.before !== undefined) return routes;
  const groups = new Map<string, Array<{ index: number; filter: RetrievalMetadataFilter }>>();
  for (const [index, query] of queries.entries()) {
    const filter = explicitQueryDateFilter(query);
    if (filter === undefined) continue;
    const key = JSON.stringify([filter.after, filter.before]);
    const group = groups.get(key) ?? [];
    group.push({ index, filter });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { filter } = group[0]!;
    const rankings = dense.search({
      ...base,
      queryVectors: group.map(({ index }) => base.queryVectors[index]!),
      filters: { ...base.filters, after: filter.after, before: filter.before },
    }).then((result) => {
      if (result.length !== group.length) {
        throw new Error("Date dense ranking count does not match query count");
      }
      return result;
    });
    for (const [offset, { index, filter: queryFilter }] of group.entries()) {
      routes.set(index, {
        filter: queryFilter,
        ranking: rankings.then((result) => result[offset]!),
      });
    }
  }
  return routes;
}
