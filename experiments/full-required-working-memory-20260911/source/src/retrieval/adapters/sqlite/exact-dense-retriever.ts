import type { EmbeddingIndexStore } from "../../model/embedding.js";
import type {
  DenseRetriever,
  DenseSearchBatchRequest,
  DenseSearchHit,
} from "../../ports/dense-retriever.js";

function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  if (left.length !== right.length) {
    throw new Error("Cosine vectors must have the same dimensions");
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new Error("Cosine vectors must contain only finite values");
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Exact SQLite implementation retained as the regression oracle. */
export class SqliteExactDenseRetriever implements DenseRetriever {
  readonly retrievalProfile = "picorer-hybrid" as const;

  constructor(private readonly store: EmbeddingIndexStore) {}

  search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]> {
    request.signal?.throwIfAborted();
    if (request.filters?.roles?.length === 0 || request.filters?.sessionIds?.length === 0) {
      return Promise.resolve(request.queryVectors.map(() => []));
    }
    const records = this.store.listStoredEmbeddings(
      request.scopeId,
      request.profile,
      request.filters,
    );
    return Promise.resolve(request.queryVectors.map((queryVector) =>
      records
        .map((candidate) => ({
          record: candidate.record,
          score: cosineSimilarity(queryVector, candidate.vector),
        }))
        .sort((left, right) =>
          right.score - left.score ||
          left.record.memoryId.localeCompare(right.record.memoryId)
        )
        .slice(0, request.limit)
        .map((hit, index) => ({ ...hit, rank: index + 1 }))
    ));
  }
}
