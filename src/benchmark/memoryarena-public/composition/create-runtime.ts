import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FileMemoryArenaGenerationStore,
} from "../adapters/filesystem-generation-store.js";
import {
  JsonlMemoryArenaWrapAuditSink,
} from "../adapters/jsonl-wrap-audit-sink.js";
import {
  JsonlMemoryArenaOperationAuditSink,
} from "../adapters/jsonl-operation-audit-sink.js";
import {
  PicorerMemoryArenaAdapter,
} from "../adapters/picorer-memory-runtime.js";
import {
  MemoryArenaMeasuredEmbedder,
  type MemoryArenaAttemptMeteredEmbedder,
} from "../adapters/measured-embedder.js";
import {
  MEMORYARENA_PUBLIC_MEMORY_SYSTEM,
} from "../model/memory-backend.js";
import {
  MemoryArenaPublicMemoryBackend,
} from "../use-cases/memory-backend.js";
import type {
  MemoryArenaOperationAuditSink,
  MemoryArenaWrapAuditSink,
} from "../ports/memory-backend.js";
import type {
  PicorerInterfaceMode,
  PicorerSkill,
} from "../../../evidence-agent/index.js";
import type { PiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import type { RetrievalMetadata } from "../../../retrieval/index.js";
import type { RetrievalProfile } from "../../../retrieval/index.js";
import { createRetrievalContext } from "../../../composition/create-retrieval-context.js";
import { ScopedQdrantRetrieval } from "../../../composition/scoped-qdrant-retrieval.js";

type MemoryArenaRetrievalProfile = Exclude<RetrievalProfile, "fts5">;

export interface CreateMemoryArenaPublicRuntimeOptions {
  dataDir: string;
  modelRuntime: PiModelRuntime;
  embedder: MemoryArenaAttemptMeteredEmbedder;
  memorySystemName?: string;
  skill?: PicorerSkill;
  interfaceMode?: PicorerInterfaceMode;
  maxRunMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  retrievalProfile?: MemoryArenaRetrievalProfile;
  environment?: NodeJS.ProcessEnv;
  auditSink?: MemoryArenaWrapAuditSink;
  operationAuditSink?: MemoryArenaOperationAuditSink;
}

export interface MemoryArenaPublicRuntime {
  backend: MemoryArenaPublicMemoryBackend;
  memorySystemName: string;
  persistenceIdentity: string;
  retrieval: RetrievalMetadata;
  operatorCatalog: ReturnType<
    ReturnType<typeof createRetrievalContext>["operatorRegistry"]["list"]
  >;
  paths: {
    root: string;
    database: string;
    generations: string;
    operationAudits: string;
    wrapAudits: string;
    persistenceIdentity: string;
  };
  close(): Promise<void>;
}

async function loadOrCreatePersistenceIdentity(path: string): Promise<string> {
  const created = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        schema_version: 1,
        identity: created,
      })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return created;
  } catch (error) {
    if (fileErrorCode(error) !== "EEXIST") throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`MemoryArena persistence identity is unreadable: ${path}`);
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    throw new Error(`MemoryArena persistence identity is invalid: ${path}`);
  }
  const record = value as Record<string, unknown>;
  const identity = record["identity"];
  if (
    record["schema_version"] !== 1 ||
    typeof identity !== "string" ||
    !identity.trim()
  ) {
    throw new Error(`MemoryArena persistence identity is invalid: ${path}`);
  }
  return identity;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export interface MemoryArenaPublicDataDirectoryLease {
  path: string;
  release(): Promise<void>;
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileErrorCode(error) !== "ESRCH";
  }
}

/** Prevents independent server processes from corrupting one generation sidecar. */
export async function acquireMemoryArenaPublicDataDirectoryLease(
  dataDir: string,
): Promise<MemoryArenaPublicDataDirectoryLease> {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = join(root, ".picorer-memoryarena.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          schema_version: 1,
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
        })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        path,
        release: async () => {
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as {
              token?: unknown;
            };
            if (current.token === token) await unlink(path);
          } catch (error) {
            if (fileErrorCode(error) !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (fileErrorCode(error) !== "EEXIST") throw error;
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      } catch (readError) {
        if (fileErrorCode(readError) === "ENOENT") continue;
        throw new Error(`MemoryArena data directory has an unreadable lock: ${path}`);
      }
      if (
        typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      ) {
        throw new Error(`MemoryArena data directory has an invalid lock: ${path}`);
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(
          `MemoryArena data directory is already owned by process ${owner.pid}: ${root}`,
        );
      }
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, stale);
        await unlink(stale);
      } catch (renameError) {
        if (fileErrorCode(renameError) !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error(`Unable to acquire MemoryArena data directory: ${root}`);
}

/** Wires the official HTTP memory contract to Picorer without benchmark policy. */
export async function createMemoryArenaPublicRuntime(
  options: CreateMemoryArenaPublicRuntimeOptions,
): Promise<MemoryArenaPublicRuntime> {
  const root = resolve(options.dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lease = await acquireMemoryArenaPublicDataDirectoryLease(root);
  const paths = {
    root,
    database: join(root, "memory.sqlite"),
    generations: join(root, "active-generations.json"),
    operationAudits: join(root, "operation-audits.jsonl"),
    wrapAudits: join(root, "wrap-audits.jsonl"),
    persistenceIdentity: join(root, "persistence-identity.json"),
  };
  let rawStore: MemoryStore | undefined;
  try {
    const [databaseExists, identityExists] = await Promise.all([
      exists(paths.database),
      exists(paths.persistenceIdentity),
    ]);
    if (databaseExists !== identityExists) {
      throw new Error(
        "MemoryArena database and persistence identity must be created together",
      );
    }
    const persistenceIdentity = await loadOrCreatePersistenceIdentity(
      paths.persistenceIdentity,
    );
    rawStore = await MemoryStore.create(paths.database);
    const measuredEmbedder = new MemoryArenaMeasuredEmbedder(options.embedder);
    const retrievalProfile = options.retrievalProfile ?? "picorer-hybrid";
    const environment = options.environment ?? process.env;
    const localRetrieval = createRetrievalContext(
      rawStore,
      "picorer-hybrid",
      measuredEmbedder,
      environment,
    );
    const scopedQdrant = retrievalProfile === "picorer-hybrid-qdrant-hnsw-v1"
      ? new ScopedQdrantRetrieval(rawStore, measuredEmbedder, environment)
      : undefined;
    const retrievalMetadata = scopedQdrant === undefined
      ? localRetrieval.metadata
      : createRetrievalContext(
          rawStore,
          retrievalProfile,
          measuredEmbedder,
          environment,
        ).metadata;
    const generations = new FileMemoryArenaGenerationStore(paths.generations);
    const fileAudits = options.auditSink === undefined
      ? new JsonlMemoryArenaWrapAuditSink(paths.wrapAudits)
      : undefined;
    const audits = options.auditSink ?? fileAudits!;
    const fileOperationAudits = options.operationAuditSink === undefined
      ? new JsonlMemoryArenaOperationAuditSink(paths.operationAudits)
      : undefined;
    const operationAudits = options.operationAuditSink ?? fileOperationAudits!;
    const memory = new PicorerMemoryArenaAdapter({
      rawStore,
      runtimeStore: localRetrieval.store,
      operatorRegistry: localRetrieval.operatorRegistry,
      ...(scopedQdrant === undefined
        ? {}
        : {
            retrievalContextForScope: (scopeId: string) =>
              scopedQdrant.context(scopeId),
          }),
      embedder: measuredEmbedder,
      modelRuntime: options.modelRuntime,
      ...(options.skill === undefined ? {} : { skill: options.skill }),
      ...(options.interfaceMode === undefined
        ? {}
        : { interfaceMode: options.interfaceMode }),
      ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.maxToolCalls === undefined
        ? {}
        : { maxToolCalls: options.maxToolCalls }),
    });
    const memorySystemName =
      options.memorySystemName ?? MEMORYARENA_PUBLIC_MEMORY_SYSTEM;
    const backend = new MemoryArenaPublicMemoryBackend({
      generations,
      chunks: memory,
      retriever: memory,
      audits,
      operationAudits,
      embeddingMeter: measuredEmbedder,
      memorySystemName,
    });
    let closed = false;
    return {
      backend,
      memorySystemName,
      persistenceIdentity,
      retrieval: retrievalMetadata,
      operatorCatalog: localRetrieval.operatorRegistry.list(),
      paths,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await Promise.all([
            fileAudits?.flush(),
            fileOperationAudits?.flush(),
          ]);
        } finally {
          try {
            rawStore!.close();
          } finally {
            await lease.release();
          }
        }
      },
    };
  } catch (error) {
    try {
      rawStore?.close();
    } finally {
      await lease.release();
    }
    throw error;
  }
}
