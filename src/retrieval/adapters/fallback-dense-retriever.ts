import type {
  DenseRetriever,
  DenseSearchBatchRequest,
  DenseSearchHit,
} from "../ports/dense-retriever.js";
import { DenseRetrievalError } from "../ports/dense-retriever.js";
import type { VectorSearchConfiguration } from "../model/search.js";

/** Falls back only when the primary dense implementation is unavailable. */
export class FallbackDenseRetriever implements DenseRetriever {
  readonly retrievalProfile;
  readonly vectorGenerationId: string;
  readonly vectorCollection: string;
  readonly vectorSearch: VectorSearchConfiguration;
  private fallbackCount = 0;

  constructor(
    private readonly primary: DenseRetriever,
    private readonly fallback: DenseRetriever,
  ) {
    this.retrievalProfile = primary.retrievalProfile;
    if (
      primary.vectorGenerationId === undefined ||
      primary.vectorCollection === undefined ||
      primary.vectorSearch === undefined
    ) {
      throw new Error(
        "Primary dense retriever must identify its vector generation and search configuration",
      );
    }
    this.vectorGenerationId = primary.vectorGenerationId;
    this.vectorCollection = primary.vectorCollection;
    this.vectorSearch = {
      ...primary.vectorSearch,
      fallbackPolicy: "sqlite-exact-on-unavailable-v1",
    };
  }

  snapshotFallbackCount(): number {
    return this.fallbackCount;
  }

  async search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]> {
    try {
      return await this.primary.search(request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (!(error instanceof DenseRetrievalError) || error.kind !== "unavailable") {
        throw error;
      }
      this.fallbackCount += 1;
      return this.fallback.search(request);
    }
  }
}
