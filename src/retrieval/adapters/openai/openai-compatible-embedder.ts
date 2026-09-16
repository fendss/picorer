import { AsyncLocalStorage } from "node:async_hooks";
import type { AsyncRequestGate } from "../../../platform/concurrency/request-gate.js";
import { sha256 } from "../../../util.js";
import type {
  Embedder,
  EmbeddingMetrics,
  EmbeddingRequestOptions,
} from "../../model/embedder.js";

export type {
  Embedder,
  EmbeddingMetrics,
  EmbeddingRequestOptions,
} from "../../model/embedder.js";

export interface OpenAICompatibleEmbedderOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
  maxInputLength?: number;
  batchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  fetchImpl?: typeof fetch;
  requestGate?: AsyncRequestGate;
}

interface EmbeddingAttemptCapture {
  observers: readonly ((metrics: EmbeddingMetrics) => void)[];
}

const SPECIAL_TOKEN_PATTERN =
  /<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>|<\|fim_prefix\|>|<\|fim_middle\|>|<\|fim_suffix\|>|<\|endofprompt\|>/gu;
const INPUT_FORMAT_VERSION = "role-colon-content-v1";
const CLEANING_VERSION = "openai-special-token-cleaning-v1";
const MAX_INPUTS_PER_REQUEST = 2048;
const MAX_CODE_POINTS_PER_REQUEST = 75_000;

class EmbeddingHttpError extends Error {
  readonly status: number;
  readonly dimensionsUnsupported: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    dimensionsUnsupported = false,
    retryAfterMs?: number,
  ) {
    super(`Embedding endpoint returned HTTP ${status}`);
    this.name = "EmbeddingHttpError";
    this.status = status;
    this.dimensionsUnsupported = dimensionsUnsupported;
    this.retryAfterMs = retryAfterMs;
  }
}

class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

class EmbeddingTimeoutError extends Error {
  constructor() {
    super("Embedding request timed out");
    this.name = "EmbeddingTimeoutError";
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

function endpointFor(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("PICORER_EMBEDDING_BASE_URL must be a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("PICORER_EMBEDDING_BASE_URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("PICORER_EMBEDDING_BASE_URL must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/embeddings`;
  return parsed.toString();
}

export function cleanEmbeddingText(text: string): string {
  const cleaned = text.replace(SPECIAL_TOKEN_PATTERN, "");
  return cleaned.length === 0 ? "." : cleaned;
}

/** Balances chunks by Unicode code point, following Picorer's Unicode code-point contract. */
export function chunkTextBalanced(text: string, maxLength: number): string[] {
  positiveInteger(maxLength, "maxLength");
  const codePoints = [...text];
  if (codePoints.length === 0) return [];
  const numberOfChunks = Math.ceil(codePoints.length / maxLength);
  const chunkSize = Math.ceil(codePoints.length / numberOfChunks);
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
    chunks.push(codePoints.slice(offset, offset + chunkSize).join(""));
  }
  return chunks;
}

function validateVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new EmbeddingResponseError(
      `Embedding response must contain ${dimensions}-dimensional vectors`,
    );
  }
  return vector.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingResponseError(
        "Embedding response contains a non-finite vector value",
      );
    }
    return value;
  });
}

function averageVectors(vectors: readonly number[][], dimensions: number): number[] {
  if (vectors.length === 0) {
    throw new Error("Cannot average an empty embedding vector group");
  }
  const average = Array.from({ length: dimensions }, () => 0);
  for (const vector of vectors) {
    const validated = validateVector(vector, dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      average[index]! += validated[index]!;
    }
  }
  for (let index = 0; index < dimensions; index += 1) {
    average[index]! /= vectors.length;
  }
  return average;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  variable: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return positiveInteger(parsed, variable);
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  variable: string,
): number {
  if (value === undefined) return fallback;
  return nonNegativeInteger(Number(value), variable);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function retryableEmbeddingError(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 ||
      error.status >= 500;
  }
  return error instanceof EmbeddingTimeoutError || error instanceof TypeError;
}

function safeEmbeddingError(error: unknown, attempts?: number): Error {
  const prefix = attempts === undefined
    ? "Embedding request failed"
    : `Embedding request failed after ${attempts} attempts`;
  if (error instanceof EmbeddingHttpError) {
    return new Error(`${prefix}: HTTP ${error.status}`);
  }
  if (error instanceof EmbeddingTimeoutError) {
    return new Error(`${prefix}: timed out`);
  }
  if (error instanceof EmbeddingResponseError) return error;
  return new Error(`${prefix}: transport error`);
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Embedding request aborted");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Embedding request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function clusterChunks(chunks: readonly string[], batchSize: number): string[][] {
  const clusters: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  const maximumCount = Math.min(batchSize, MAX_INPUTS_PER_REQUEST);
  for (const chunk of chunks) {
    const length = [...chunk].length;
    if (
      current.length > 0 &&
      (current.length >= maximumCount ||
        currentLength + length > MAX_CODE_POINTS_PER_REQUEST)
    ) {
      clusters.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(chunk);
    currentLength += length;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly profileId: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputLength: number;
  readonly batchSize: number;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestGate: AsyncRequestGate | undefined;
  private readonly attemptCapture =
    new AsyncLocalStorage<EmbeddingAttemptCapture>();
  private dimensionsParameterEnabled = true;
  private calls = 0;
  private latencyMs = 0;
  private inputTokens = 0;
  private usageMissingCalls = 0;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("PICORER_EMBEDDING_API_KEY is required for picorer-hybrid");
    }
    this.endpoint = endpointFor(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || "text-embedding-v4";
    this.dimensions = positiveInteger(options.dimensions ?? 1024, "dimensions");
    this.maxInputLength = positiveInteger(
      options.maxInputLength ?? 2048,
      "maxInputLength",
    );
    this.batchSize = positiveInteger(options.batchSize ?? 10, "batchSize");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? 4, "maxRetries");
    this.retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs ?? 1_000,
      "retryBaseDelayMs",
    );
    this.retryMaxDelayMs = positiveInteger(
      options.retryMaxDelayMs ?? 30_000,
      "retryMaxDelayMs",
    );
    if (this.retryBaseDelayMs > this.retryMaxDelayMs) {
      throw new Error("retryBaseDelayMs must not exceed retryMaxDelayMs");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestGate = options.requestGate;
    const profileConfig = JSON.stringify({
      provider: "openai-compatible",
      endpointFingerprint: sha256(this.endpoint),
      model: this.model,
      dimensions: this.dimensions,
      similarity: "cosine",
      maxInputLength: this.maxInputLength,
      inputFormat: INPUT_FORMAT_VERSION,
      cleaning: CLEANING_VERSION,
      chunkAggregation: "arithmetic-mean-v1",
    });
    this.profileId = `embedding-${sha256(profileConfig).slice(0, 24)}`;
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof fetch,
    requestGate?: AsyncRequestGate,
  ): OpenAICompatibleEmbedder {
    const baseUrl = environment.PICORER_EMBEDDING_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error("PICORER_EMBEDDING_BASE_URL is required for picorer-hybrid");
    }
    const apiKey = environment.PICORER_EMBEDDING_API_KEY;
    if (!apiKey?.trim()) {
      throw new Error("PICORER_EMBEDDING_API_KEY is required for picorer-hybrid");
    }
    return new OpenAICompatibleEmbedder({
      baseUrl,
      apiKey,
      model: environment.PICORER_EMBEDDING_MODEL?.trim() || "text-embedding-v4",
      dimensions: parsePositiveInteger(
        environment.PICORER_EMBEDDING_DIMENSIONS,
        1024,
        "PICORER_EMBEDDING_DIMENSIONS",
      ),
      maxInputLength: parsePositiveInteger(
        environment.PICORER_EMBEDDING_MAX_INPUT_LENGTH,
        2048,
        "PICORER_EMBEDDING_MAX_INPUT_LENGTH",
      ),
      batchSize: parsePositiveInteger(
        environment.PICORER_EMBEDDING_BATCH_SIZE,
        10,
        "PICORER_EMBEDDING_BATCH_SIZE",
      ),
      timeoutMs: parsePositiveInteger(
        environment.PICORER_EMBEDDING_TIMEOUT_MS,
        30_000,
        "PICORER_EMBEDDING_TIMEOUT_MS",
      ),
      maxRetries: parseNonNegativeInteger(
        environment.PICORER_EMBEDDING_MAX_RETRIES,
        4,
        "PICORER_EMBEDDING_MAX_RETRIES",
      ),
      retryBaseDelayMs: parsePositiveInteger(
        environment.PICORER_EMBEDDING_RETRY_BASE_MS,
        1_000,
        "PICORER_EMBEDDING_RETRY_BASE_MS",
      ),
      retryMaxDelayMs: parsePositiveInteger(
        environment.PICORER_EMBEDDING_RETRY_MAX_MS,
        30_000,
        "PICORER_EMBEDDING_RETRY_MAX_MS",
      ),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(requestGate === undefined ? {} : { requestGate }),
    });
  }

  embedDocuments(
    texts: readonly string[],
    options: EmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    return this.embed(texts, options.signal);
  }

  embedQueries(
    texts: readonly string[],
    options: EmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    return this.embed(texts, options.signal);
  }

  snapshotMetrics(): EmbeddingMetrics {
    return {
      calls: this.calls,
      latencyMs: this.latencyMs,
      inputTokens: this.inputTokens,
      usageMissingCalls: this.usageMissingCalls,
    };
  }

  /**
   * Observes exact metrics for each provider request started by `operation`.
   * This is intentionally independent of process-cumulative snapshots so
   * concurrent logical operations can attribute their own attempts exactly.
   */
  captureEmbeddingAttempts<T>(
    observer: (metrics: EmbeddingMetrics) => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    const parent = this.attemptCapture.getStore();
    const capture: EmbeddingAttemptCapture = {
      observers: [...(parent?.observers ?? []), observer],
    };
    return this.attemptCapture.run(capture, operation);
  }

  private async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const chunksByInput = texts.map((text) =>
      chunkTextBalanced(cleanEmbeddingText(text), this.maxInputLength),
    );
    const flatChunks = chunksByInput.flat();
    const clusters = clusterChunks(flatChunks, this.batchSize);
    const flatVectors: number[][] = [];
    for (const cluster of clusters) {
      flatVectors.push(...await this.embedCluster(cluster, signal));
    }

    const results: number[][] = [];
    let offset = 0;
    for (const chunks of chunksByInput) {
      const vectors = flatVectors.slice(offset, offset + chunks.length);
      results.push(averageVectors(vectors, this.dimensions));
      offset += chunks.length;
    }
    if (offset !== flatVectors.length) {
      throw new Error("Embedding response could not be mapped back to inputs");
    }
    return results;
  }

  private embedCluster(
    inputs: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return this.embedClusterWithRetries(inputs, signal);
  }

  private requestThroughGate(
    inputs: readonly string[],
    includeDimensions: boolean,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const operation = (): Promise<number[][]> =>
      this.request(inputs, includeDimensions, signal);
    return this.requestGate ? this.requestGate.run(operation) : operation();
  }

  private async embedClusterWithRetries(
    inputs: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    let includeDimensions = this.dimensionsParameterEnabled;
    let usedNoDimensionsFallback = false;
    let retryDelayMs = this.retryBaseDelayMs;
    let retries = 0;
    while (true) {
      try {
        const result = await this.requestThroughGate(
          inputs,
          includeDimensions,
          signal,
        );
        if (!includeDimensions) this.dimensionsParameterEnabled = false;
        return result;
      } catch (error) {
        if (
          error instanceof EmbeddingHttpError &&
          error.status === 400 &&
          error.dimensionsUnsupported &&
          includeDimensions &&
          !usedNoDimensionsFallback
        ) {
          includeDimensions = false;
          usedNoDimensionsFallback = true;
          try {
            const result = await this.requestThroughGate(inputs, false, signal);
            this.dimensionsParameterEnabled = false;
            return result;
          } catch (fallbackError) {
            error = fallbackError;
          }
        }
        if (signal?.aborted) throw new Error("Embedding request aborted");
        if (!retryableEmbeddingError(error)) throw safeEmbeddingError(error);
        if (retries >= this.maxRetries) {
          throw safeEmbeddingError(error, retries + 1);
        }
        const requestedDelay = error instanceof EmbeddingHttpError
          ? error.retryAfterMs
          : undefined;
        await wait(
          Math.min(requestedDelay ?? retryDelayMs, this.retryMaxDelayMs),
          signal,
        );
        retries += 1;
        retryDelayMs = Math.min(retryDelayMs * 2, this.retryMaxDelayMs);
      }
    }
  }

  private async request(
    inputs: readonly string[],
    includeDimensions: boolean,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (signal?.aborted) throw new Error("Embedding request aborted");
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = (): void => controller.abort();
    signal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timeout.unref();
    const started = performance.now();
    let inputTokens: number | undefined;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: inputs,
          model: this.model,
          ...(includeDimensions ? { dimensions: this.dimensions } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        try {
          inputTokens = this.parseInputTokens(JSON.parse(errorText));
        } catch {
          // Most error payloads do not expose usage. Missing usage is recorded
          // for this provider attempt in the shared finally block below.
        }
        throw new EmbeddingHttpError(
          response.status,
          response.status === 400 && /dimensions?/iu.test(errorText),
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new EmbeddingResponseError(
          "Embedding endpoint returned invalid JSON",
        );
      }
      inputTokens = this.parseInputTokens(payload);
      return this.parseResponse(payload, inputs.length);
    } catch (error) {
      if (timedOut) throw new EmbeddingTimeoutError();
      if (signal?.aborted) throw new Error("Embedding request aborted");
      throw error;
    } finally {
      const latencyMs = performance.now() - started;
      const metrics: EmbeddingMetrics = {
        calls: 1,
        latencyMs,
        inputTokens: inputTokens ?? 0,
        usageMissingCalls: inputTokens === undefined ? 1 : 0,
      };
      this.calls += 1;
      this.latencyMs += latencyMs;
      this.inputTokens += metrics.inputTokens ?? 0;
      this.usageMissingCalls += metrics.usageMissingCalls ?? 0;
      for (const observer of this.attemptCapture.getStore()?.observers ?? []) {
        try {
          observer(metrics);
        } catch {
          // Metrics observers must never replace a provider result or error.
        }
      }
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private parseResponse(payload: unknown, inputCount: number): number[][] {
    if (typeof payload !== "object" || payload === null || !("data" in payload)) {
      throw new EmbeddingResponseError(
        "Embedding endpoint response has no data array",
      );
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== inputCount) {
      throw new EmbeddingResponseError(
        "Embedding endpoint returned an incomplete data array",
      );
    }
    const ordered: Array<number[] | undefined> = Array.from(
      { length: inputCount },
      () => undefined,
    );
    for (const item of data) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("index" in item) ||
        !("embedding" in item)
      ) {
        throw new EmbeddingResponseError(
          "Embedding endpoint returned an invalid data item",
        );
      }
      const index = (item as { index?: unknown }).index;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= inputCount ||
        ordered[index] !== undefined
      ) {
        throw new EmbeddingResponseError(
          "Embedding endpoint returned invalid or duplicate indexes",
        );
      }
      ordered[index] = validateVector(
        (item as { embedding?: unknown }).embedding,
        this.dimensions,
      );
    }
    if (ordered.some((vector) => vector === undefined)) {
      throw new EmbeddingResponseError(
        "Embedding endpoint response indexes are incomplete",
      );
    }
    return ordered as number[][];
  }

  private parseInputTokens(payload: unknown): number | undefined {
    if (typeof payload !== "object" || payload === null || !("usage" in payload)) {
      return undefined;
    }
    const usage = (payload as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const record = usage as Record<string, unknown>;
    for (const key of ["prompt_tokens", "input_tokens", "total_tokens"]) {
      const value = record[key];
      if (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ) return value;
    }
    return undefined;
  }
}
