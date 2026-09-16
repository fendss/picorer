import type { RetrievalHit } from "./search.js";

function unionBy<T>(left: readonly T[] | undefined, right: readonly T[] | undefined,
  key: (value: T) => string): T[] | undefined {
  if (left === undefined && right === undefined) return undefined;
  return [...new Map([...(left ?? []), ...(right ?? [])].map((value) => [key(value), value])).values()];
}

/** Keep all source coordinates when different discovery routes meet. */
export function mergeHitProvenance(left: RetrievalHit, right: RetrievalHit): RetrievalHit {
  if (left.record.memoryId !== right.record.memoryId ||
      left.record.scopeId !== right.record.scopeId ||
      left.record.contentHash !== right.record.contentHash ||
      left.record.content !== right.record.content) {
    throw new Error(`Cannot merge conflicting source ${left.record.memoryId}`);
  }
  const matchedMetadataFilters = unionBy(left.matchedMetadataFilters, right.matchedMetadataFilters,
    (filter) => JSON.stringify([filter.source, filter.query, filter.after, filter.before]));
  const operatorSourceSpans = unionBy(left.operatorSourceSpans, right.operatorSourceSpans,
    (span) => `${span.start}:${span.end}`);
  const operatorNumericFactIndexes = unionBy(left.operatorNumericFactIndexes, right.operatorNumericFactIndexes, String);
  const operatorTemporalFacts = unionBy(left.operatorTemporalFacts, right.operatorTemporalFacts,
    (fact) => JSON.stringify([fact.expression, fact.resolvedDate, fact.basis]));
  return {
    ...left,
    matchedQueries: [...new Set([...(left.matchedQueries ?? [left.query]), ...(right.matchedQueries ?? [right.query])])],
    ...(matchedMetadataFilters === undefined ? {} : { matchedMetadataFilters }),
    ...(operatorSourceSpans === undefined ? {} : { operatorSourceSpans }),
    ...(operatorNumericFactIndexes === undefined ? {} : { operatorNumericFactIndexes }),
    ...(operatorTemporalFacts === undefined ? {} : { operatorTemporalFacts }),
  };
}
