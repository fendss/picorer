import type { OnlineMemoryStore } from "../../memory/index.js";
import { createRetrievalContext } from "../../composition/create-retrieval-context.js";
import { ScopedQdrantRetrieval } from "../../composition/scoped-qdrant-retrieval.js";
import { runPicorer } from "../../evidence-agent/index.js";
import type { PiModelRuntime } from "../../platform/pi/load-model-runtime.js";
import type { MemoryStore } from "../../platform/sqlite/picorer-store.js";
import {
  embeddingProfile,
  indexScopeEmbeddings,
  type Embedder,
  type RetrievalProfile,
} from "../../retrieval/index.js";
import { sha256 } from "../../util.js";
import {
  LdbdContractError,
  renderRetrievalQuestion,
  type LdbdAddRequest,
  type LdbdSearchRequest,
} from "./contracts.js";
import {
  LdbdConflictError,
  type LdbdMemoryApplication,
  type LdbdSearchItem,
  LdbdUnavailableError,
  onlineScopeId,
} from "./service.js";

class KeyedSerialExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => current);
    this.tails.set(key, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function requestHash(request: LdbdAddRequest): string {
  return sha256(JSON.stringify(request));
}

function timestamp(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("message timestamp is outside the supported date range");
  }
  return parsed.toISOString();
}

export class PicorerLdbdApplication implements LdbdMemoryApplication {
  private readonly serial = new KeyedSerialExecutor();
  private readonly retrievalProfile: RetrievalProfile;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly scopedQdrant: ScopedQdrantRetrieval | undefined;

  constructor(
    private readonly store: MemoryStore & OnlineMemoryStore,
    private readonly embedder: Embedder,
    private readonly modelRuntime: PiModelRuntime,
    options: {
      retrievalProfile?: RetrievalProfile;
      environment?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.retrievalProfile = options.retrievalProfile ?? "picorer-hybrid";
    this.environment = options.environment ?? process.env;
    this.scopedQdrant = this.retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1"
      ? new ScopedQdrantRetrieval(this.store, this.embedder, this.environment)
      : undefined;
  }

  async add(request: LdbdAddRequest): Promise<"inserted" | "unchanged"> {
    const scopeId = onlineScopeId(request.userId);
    return this.serial.run(scopeId, async () => {
      const hash = requestHash(request);
      let appended;
      try {
        appended = this.store.appendMemoryRequest({
          requestId: request.requestId,
          requestHash: hash,
          scopeId,
          sourceSessionId: request.sessionId,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.timestamp === undefined
              ? {}
              : { timestamp: timestamp(message.timestamp)! }),
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/conflict|sealed/iu.test(message)) throw new LdbdConflictError(message);
        throw error;
      }
      if (appended.status === "complete") return "unchanged";

      if (this.retrievalProfile !== "fts5") {
        const indexed = await indexScopeEmbeddings(this.store, scopeId, this.embedder);
        if (indexed.missing !== 0) {
          throw new LdbdUnavailableError(
            `Embedding index is incomplete for scope ${scopeId}: ` +
              `${indexed.indexed}/${indexed.total}`,
          );
        }
      }
      this.store.markAppendRequestComplete(request.requestId, hash);
      return "inserted";
    });
  }

  async search(request: LdbdSearchRequest, signal?: AbortSignal): Promise<LdbdSearchItem[]> {
    signal?.throwIfAborted();
    const scopeId = onlineScopeId(request.userId);
    await this.serial.run(scopeId, async () => {
      signal?.throwIfAborted();
      try {
        this.store.sealOnlineScope(scopeId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No memories/iu.test(message)) throw new LdbdContractError(message);
        if (/incomplete/iu.test(message)) throw new LdbdUnavailableError(message);
        throw error;
      }
      if (this.retrievalProfile !== "fts5") {
        const status = this.store.getEmbeddingIndexStatus(
          scopeId,
          embeddingProfile(this.embedder),
        );
        if (status.total === 0 || status.missing !== 0) {
          throw new LdbdUnavailableError(
            `Embedding index is incomplete for scope ${scopeId}: ` +
              `${status.indexed}/${status.total}`,
          );
        }
      }
    });

    signal?.throwIfAborted();
    const retrieval = this.scopedQdrant === undefined
      ? createRetrievalContext(
          this.store,
          this.retrievalProfile,
          this.embedder,
          this.environment,
        )
      : await this.scopedQdrant.context(scopeId);
    const result = await runPicorer({
      store: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      modelRuntime: this.modelRuntime,
      scopeId,
      question: renderRetrievalQuestion(request),
      maxRunMs: 120_000,
      maxTurns: 16,
      maxToolCalls: 40,
      ...(signal === undefined ? {} : { signal }),
    });
    const evidence = new Map(result.evidence.map((memory) => [memory.memoryId, memory]));
    const output: LdbdSearchItem[] = [];
    for (const citation of result.citations) {
      const memory = evidence.get(citation.memoryId);
      if (!memory || output.some((item) => item.id === memory.memoryId)) continue;
      output.push({
        id: memory.memoryId,
        content: memory.content,
        ...(memory.timestamp === undefined ? {} : { created_at: memory.timestamp }),
      });
      if (output.length >= request.topK) break;
    }
    return output;
  }
}
