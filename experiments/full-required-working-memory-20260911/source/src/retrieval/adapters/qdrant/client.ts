import { parseSourceTimestamp } from "../../model/source-time.js";
import type { MemoryRole } from "../../../memory/index.js";

export const QDRANT_COLLECTION_SCHEMA_VERSION = 2;

export interface QdrantHnswConfig {
  m: number;
  efConstruct: number;
  fullScanThresholdKb: number;
}

export interface QdrantCollectionSpec {
  name: string;
  dimensions: number;
  indexingThresholdKb: number;
  hnsw: QdrantHnswConfig;
}

export interface QdrantCollectionInfo {
  status: string;
  optimizerStatus: string;
  pointsCount: number;
  indexedVectorsCount: number;
  segmentsCount: number;
  dimensions: number;
  indexingThresholdKb: number;
  distance: string;
  hnsw: QdrantHnswConfig;
}

export interface QdrantVectorPoint {
  pointId: string;
  vector: readonly number[];
  generationId: string;
  scopeId: string;
  memoryId: string;
  sessionId: string;
  role: MemoryRole;
  timestamp?: string;
  profileId: string;
  contentHash: string;
}

export interface QdrantSearchRequest {
  collection: string;
  vector: readonly number[];
  generationId: string;
  scopeId: string;
  profileId: string;
  sessionIds?: string[];
  roles?: MemoryRole[];
  after?: string;
  before?: string;
  limit: number;
  hnswEf: number;
  signal?: AbortSignal;
}

export interface QdrantSearchHit {
  pointId: string;
  score: number;
  generationId: string;
  scopeId: string;
  memoryId: string;
  sessionId: string;
  role: MemoryRole;
  timestamp?: string;
  profileId: string;
  contentHash: string;
  schemaVersion: number;
}

export interface QdrantCountRequest {
  collection: string;
  generationId: string;
  profileId: string;
  scopeId?: string;
  signal?: AbortSignal;
}

export interface QdrantClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class QdrantHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "QdrantHttpError";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function memoryRole(value: unknown, label: string): MemoryRole {
  if (!new Set(["user", "assistant", "system", "other"]).has(String(value))) {
    throw new Error(`${label} must be a supported memory role`);
  }
  return value as MemoryRole;
}

function dateTimeMilliseconds(value: string, label: string): number {
  const milliseconds = parseSourceTimestamp(nonEmpty(value, label));
  if (milliseconds === undefined) {
    throw new Error(`${label} must be a supported Qdrant datetime`);
  }
  return milliseconds;
}

function dateTime(value: string, label: string): string {
  dateTimeMilliseconds(value, label);
  return value;
}

function collectionName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,255}$/u.test(value)) {
    throw new Error("Qdrant collection name contains unsupported characters");
  }
  return value;
}

function baseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Qdrant base URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Qdrant base URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Qdrant base URL must not contain credentials, query, or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function finiteVector(vector: readonly number[], dimensions?: number): number[] {
  if (dimensions !== undefined && vector.length !== dimensions) {
    throw new Error(`Qdrant vector must contain ${dimensions} dimensions`);
  }
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Qdrant vector must be non-empty and finite");
  }
  return [...vector];
}

function responseSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function responseMessage(status: number, body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim().slice(0, 500);
  return compact
    ? `Qdrant returned HTTP ${status}: ${compact}`
    : `Qdrant returned HTTP ${status}`;
}

function optimizerStatus(value: unknown): string {
  if (typeof value === "string") return nonEmpty(value, "Qdrant optimizer status");
  return nonEmpty(
    String(objectValue(value, "Qdrant optimizer status").status ?? ""),
    "Qdrant optimizer status",
  );
}

function parseCollectionInfo(value: unknown): QdrantCollectionInfo {
  const result = objectValue(
    objectValue(value, "Qdrant collection response").result,
    "Qdrant collection result",
  );
  const config = objectValue(result.config, "Qdrant collection config");
  const params = objectValue(config.params, "Qdrant collection parameters");
  const vectors = objectValue(params.vectors, "Qdrant vector parameters");
  const hnsw = objectValue(config.hnsw_config, "Qdrant HNSW parameters");
  const optimizer = objectValue(
    config.optimizer_config,
    "Qdrant optimizer parameters",
  );
  return {
    status: nonEmpty(String(result.status ?? ""), "Qdrant status"),
    optimizerStatus: optimizerStatus(result.optimizer_status),
    pointsCount: nonNegativeInteger(Number(result.points_count), "Qdrant point count"),
    indexedVectorsCount: nonNegativeInteger(
      Number(result.indexed_vectors_count),
      "Qdrant indexed vector count",
    ),
    segmentsCount: nonNegativeInteger(
      Number(result.segments_count),
      "Qdrant segment count",
    ),
    dimensions: positiveInteger(Number(vectors.size), "Qdrant vector size"),
    indexingThresholdKb: positiveInteger(
      Number(optimizer.indexing_threshold),
      "Qdrant indexing threshold",
    ),
    distance: nonEmpty(String(vectors.distance ?? ""), "Qdrant distance"),
    hnsw: {
      m: positiveInteger(Number(hnsw.m), "Qdrant HNSW m"),
      efConstruct: positiveInteger(Number(hnsw.ef_construct), "Qdrant HNSW ef_construct"),
      fullScanThresholdKb: positiveInteger(
        Number(hnsw.full_scan_threshold),
        "Qdrant HNSW full_scan_threshold",
      ),
    },
  };
}

/** Minimal HTTP adapter; Qdrant is never trusted as the source of memory text. */
export class QdrantClient {
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QdrantClientOptions) {
    this.base = baseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "Qdrant timeout");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      signal?: AbortSignal;
      acceptedStatuses?: readonly number[];
    } = {},
  ): Promise<{ status: number; value: unknown }> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.apiKey === undefined ? {} : { "api-key": this.apiKey }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: responseSignal(this.timeoutMs, options.signal),
    });
    const body = await response.text();
    if (!(options.acceptedStatuses ?? [200]).includes(response.status)) {
      throw new QdrantHttpError(response.status, responseMessage(response.status, body));
    }
    if (!body.trim()) return { status: response.status, value: undefined };
    try {
      return { status: response.status, value: JSON.parse(body) as unknown };
    } catch {
      return { status: response.status, value: body };
    }
  }

  async getCollection(
    name: string,
    signal?: AbortSignal,
  ): Promise<QdrantCollectionInfo | undefined> {
    const response = await this.request(
      "GET",
      `/collections/${encodeURIComponent(collectionName(name))}`,
      {
        acceptedStatuses: [200, 404],
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return response.status === 404 ? undefined : parseCollectionInfo(response.value);
  }

  private async ensurePayloadIndex(
    collection: string,
    fieldName: string,
    fieldSchema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/collections/${encodeURIComponent(collectionName(collection))}/index?wait=true`,
      {
        body: { field_name: fieldName, field_schema: fieldSchema },
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async ensureCollection(
    spec: QdrantCollectionSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    collectionName(spec.name);
    positiveInteger(spec.dimensions, "Qdrant collection dimensions");
    positiveInteger(spec.indexingThresholdKb, "Qdrant indexing threshold");
    positiveInteger(spec.hnsw.m, "Qdrant HNSW m");
    positiveInteger(spec.hnsw.efConstruct, "Qdrant HNSW ef_construct");
    positiveInteger(spec.hnsw.fullScanThresholdKb, "Qdrant HNSW full_scan_threshold");
    let info = await this.getCollection(spec.name, signal);
    if (info === undefined) {
      try {
        await this.request("PUT", `/collections/${encodeURIComponent(spec.name)}`, {
          body: {
            vectors: { size: spec.dimensions, distance: "Cosine" },
            hnsw_config: {
              m: spec.hnsw.m,
              ef_construct: spec.hnsw.efConstruct,
              full_scan_threshold: spec.hnsw.fullScanThresholdKb,
            },
            optimizers_config: { indexing_threshold: spec.indexingThresholdKb },
            on_disk_payload: false,
          },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        // Another publisher can win the create race. The schema check below
        // still fails closed if that collection is not the one we requested.
        if (!(error instanceof QdrantHttpError) || error.status !== 409) {
          throw error;
        }
      }
      info = await this.getCollection(spec.name, signal);
    }
    if (info === undefined) {
      throw new Error(`Qdrant collection was not created: ${spec.name}`);
    }
    if (
      info.dimensions !== spec.dimensions ||
      info.distance.toLowerCase() !== "cosine" ||
      info.hnsw.m !== spec.hnsw.m ||
      info.hnsw.efConstruct !== spec.hnsw.efConstruct ||
      info.hnsw.fullScanThresholdKb !== spec.hnsw.fullScanThresholdKb ||
      info.indexingThresholdKb !== spec.indexingThresholdKb
    ) {
      throw new Error(`Qdrant collection configuration mismatch: ${spec.name}`);
    }
    for (const [field, schema] of [
      ["scope_id", { type: "keyword", is_tenant: true }],
      ["profile_id", { type: "keyword" }],
      ["generation_id", { type: "keyword" }],
      ["session_id", { type: "keyword" }],
      ["role", { type: "keyword" }],
      ["timestamp", { type: "datetime" }],
      ["schema_version", { type: "integer" }],
    ] as const) {
      await this.ensurePayloadIndex(spec.name, field, schema, signal);
    }
  }

  async upsert(
    collection: string,
    dimensions: number,
    points: readonly QdrantVectorPoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    collectionName(collection);
    if (points.length === 0) return;
    if (new Set(points.map((point) => point.pointId)).size !== points.length) {
      throw new Error("Qdrant upsert batch contains duplicate point IDs");
    }
    await this.request(
      "PUT",
      `/collections/${encodeURIComponent(collection)}/points?wait=true`,
      {
        body: {
          points: points.map((point) => ({
            id: nonEmpty(point.pointId, "Qdrant point ID"),
            vector: finiteVector(point.vector, dimensions),
            payload: {
              generation_id: nonEmpty(point.generationId, "Qdrant generation ID"),
              scope_id: nonEmpty(point.scopeId, "Qdrant scope ID"),
              memory_id: nonEmpty(point.memoryId, "Qdrant memory ID"),
              session_id: nonEmpty(point.sessionId, "Qdrant session ID"),
              role: memoryRole(point.role, "Qdrant memory role"),
              ...(point.timestamp === undefined
                ? {}
                : { timestamp: dateTime(point.timestamp, "Qdrant timestamp") }),
              profile_id: nonEmpty(point.profileId, "Qdrant profile ID"),
              content_hash: nonEmpty(point.contentHash, "Qdrant content hash"),
              schema_version: QDRANT_COLLECTION_SCHEMA_VERSION,
            },
          })),
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async count(request: QdrantCountRequest): Promise<number> {
    const must: Array<Record<string, unknown>> = [
      { key: "schema_version", match: { value: QDRANT_COLLECTION_SCHEMA_VERSION } },
      { key: "generation_id", match: { value: nonEmpty(request.generationId, "generation ID") } },
      { key: "profile_id", match: { value: nonEmpty(request.profileId, "profile ID") } },
    ];
    if (request.scopeId !== undefined) {
      must.push({ key: "scope_id", match: { value: nonEmpty(request.scopeId, "scope ID") } });
    }
    const response = await this.request(
      "POST",
      `/collections/${encodeURIComponent(collectionName(request.collection))}/points/count`,
      {
        body: { filter: { must }, exact: true },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    const result = objectValue(
      objectValue(response.value, "Qdrant count response").result,
      "Qdrant count result",
    );
    return nonNegativeInteger(Number(result.count), "Qdrant filtered point count");
  }

  async search(request: QdrantSearchRequest): Promise<QdrantSearchHit[]> {
    request.signal?.throwIfAborted();
    if (request.roles?.length === 0 || request.sessionIds?.length === 0) return [];
    positiveInteger(request.limit, "Qdrant search limit");
    positiveInteger(request.hnswEf, "Qdrant HNSW ef");
    const afterMs = request.after === undefined
      ? undefined
      : dateTimeMilliseconds(request.after, "Qdrant lower datetime bound");
    const beforeMs = request.before === undefined
      ? undefined
      : dateTimeMilliseconds(request.before, "Qdrant upper datetime bound");
    if (afterMs !== undefined && beforeMs !== undefined && afterMs > beforeMs) {
      throw new Error("Qdrant datetime bounds are reversed");
    }
    const must: Array<Record<string, unknown>> = [
      { key: "schema_version", match: { value: QDRANT_COLLECTION_SCHEMA_VERSION } },
      { key: "generation_id", match: { value: nonEmpty(request.generationId, "generation ID") } },
      { key: "scope_id", match: { value: nonEmpty(request.scopeId, "scope ID") } },
      { key: "profile_id", match: { value: nonEmpty(request.profileId, "profile ID") } },
    ];
    if (request.sessionIds?.length) {
      must.push({ key: "session_id", match: { any: request.sessionIds } });
    }
    if (request.roles?.length) {
      must.push({ key: "role", match: { any: request.roles } });
    }
    if (request.after !== undefined || request.before !== undefined) {
      must.push({
        key: "timestamp",
        range: {
          ...(request.after === undefined ? {} : { gte: request.after }),
          ...(request.before === undefined ? {} : { lte: request.before }),
        },
      });
    }
    const response = await this.request(
      "POST",
      `/collections/${encodeURIComponent(collectionName(request.collection))}/points/query`,
      {
        body: {
          query: finiteVector(request.vector),
          filter: { must },
          params: { hnsw_ef: request.hnswEf, exact: false },
          limit: request.limit,
          with_payload: [
            "generation_id",
            "scope_id",
            "memory_id",
            "session_id",
            "role",
            "timestamp",
            "profile_id",
            "content_hash",
            "schema_version",
          ],
          with_vector: false,
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    const envelope = objectValue(response.value, "Qdrant query response");
    const result = objectValue(envelope.result, "Qdrant query result");
    if (!Array.isArray(result.points)) {
      throw new Error("Qdrant query points must be an array");
    }
    return result.points.map((raw, index) => {
      const result = objectValue(raw, `Qdrant result ${index}`);
      const payload = objectValue(result.payload, `Qdrant result ${index} payload`);
      const hit = {
        pointId: nonEmpty(String(result.id ?? ""), "Qdrant point ID"),
        score: Number(result.score),
        generationId: nonEmpty(String(payload.generation_id ?? ""), "generation ID"),
        scopeId: nonEmpty(String(payload.scope_id ?? ""), "scope ID"),
        memoryId: nonEmpty(String(payload.memory_id ?? ""), "memory ID"),
        sessionId: nonEmpty(String(payload.session_id ?? ""), "session ID"),
        role: memoryRole(payload.role, "memory role"),
        ...(payload.timestamp === undefined
          ? {}
          : { timestamp: nonEmpty(String(payload.timestamp), "timestamp") }),
        profileId: nonEmpty(String(payload.profile_id ?? ""), "profile ID"),
        contentHash: nonEmpty(String(payload.content_hash ?? ""), "content hash"),
        schemaVersion: positiveInteger(
          Number(payload.schema_version),
          "schema version",
        ),
      };
      if (!Number.isFinite(hit.score)) throw new Error("Qdrant score must be finite");
      if (
        hit.generationId !== request.generationId ||
        hit.schemaVersion !== QDRANT_COLLECTION_SCHEMA_VERSION ||
        hit.scopeId !== request.scopeId ||
        hit.profileId !== request.profileId ||
        (request.sessionIds?.length && !request.sessionIds.includes(hit.sessionId)) ||
        (request.roles?.length && !request.roles.includes(hit.role)) ||
        (afterMs !== undefined &&
          (hit.timestamp === undefined ||
            dateTimeMilliseconds(hit.timestamp, "Qdrant result timestamp") < afterMs)) ||
        (beforeMs !== undefined &&
          (hit.timestamp === undefined ||
            dateTimeMilliseconds(hit.timestamp, "Qdrant result timestamp") > beforeMs))
      ) {
        throw new Error("Qdrant returned a result outside the mandatory filter");
      }
      return hit;
    });
  }
}
