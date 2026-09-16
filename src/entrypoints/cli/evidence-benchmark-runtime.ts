import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  LoadPiModelRuntimeOptions,
  PiModelRuntime,
} from "../../platform/pi/load-model-runtime.js";
import { safePathSegment, sha256 } from "../../util.js";
import {
  MODEL_RUNTIME_FLAG_NAMES,
  modelOptionsFor,
  type ParsedCommand,
} from "./parse-command.js";
import {
  readJsonFileIfPresent,
  writeAtomicJson,
} from "./workflow-files.js";

export const BENCHMARK_MODEL_ROLES = [
  "retrieval",
  "answer",
  "judge",
] as const;

export type BenchmarkModelRole = (typeof BENCHMARK_MODEL_ROLES)[number];

export const BENCHMARK_MODEL_FLAG_NAMES = MODEL_RUNTIME_FLAG_NAMES;

export const BENCHMARK_MODEL_FLAGS: readonly string[] = [
  ...BENCHMARK_MODEL_FLAG_NAMES,
  ...BENCHMARK_MODEL_ROLES.flatMap((role) =>
    BENCHMARK_MODEL_FLAG_NAMES.map((name) => `${role}-${name}`)
  ),
];

/** Resolves one role's model flags with field-wise unprefixed fallbacks. */
export function benchmarkModelOptionsFor(
  parsed: ParsedCommand,
  role: BenchmarkModelRole,
): LoadPiModelRuntimeOptions {
  const flags = new Map<string, string[]>();
  for (const name of BENCHMARK_MODEL_FLAG_NAMES) {
    const values = parsed.flags.get(`${role}-${name}`) ?? parsed.flags.get(name);
    if (values !== undefined) flags.set(name, values);
  }
  return modelOptionsFor({ command: parsed.command, flags });
}

export interface BenchmarkRuntimeIdentity {
  modelAdapterId: string;
  providerId: string;
  modelId: string;
  thinkingLevel: PiModelRuntime["thinkingLevel"];
  transport: PiModelRuntime["transport"];
  api: PiModelRuntime["model"]["api"];
  baseUrl: string;
  requestPolicy?: PiModelRuntime["requestPolicy"];
}

export function benchmarkRuntimeIdentity(
  runtime: PiModelRuntime,
): BenchmarkRuntimeIdentity {
  return {
    modelAdapterId: runtime.modelAdapterId,
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    thinkingLevel: runtime.thinkingLevel,
    transport: runtime.transport,
    api: runtime.model.api,
    baseUrl: runtime.model.baseUrl,
    ...(runtime.requestPolicy === undefined
      ? {}
      : { requestPolicy: runtime.requestPolicy }),
  };
}

/** Stops queue refill for explicit provider-wide failures without matching IDs. */
export function benchmarkSystemicRuntimeFailure(message: string): boolean {
  return /(?:HTTP(?:\s+error)?\s*[:=]?\s*(?:401|403|429)\b|(?:401|403|429)\s+status code\b|status(?:\s+code)?\s*[:=]\s*(?:401|403|429)\b|rate[ -]?limit(?:ed|ing)?|too many requests|invalid (?:api[ -]?key|token)|authentication failed|provider substituted model|model .*not found)/iu.test(
    message,
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must contain only finite numbers`);
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError(`${path} must not contain a cycle`);
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item, index) => {
            if (item === undefined) {
              throw new TypeError(`${path}[${index}] must not be undefined`);
            }
            return canonicalJson(item, `${path}[${index}]`, ancestors);
          }).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(`${path} must contain only plain objects`);
        }
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort(compareText)
          .map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(
              record[key],
              `${path}.${key}`,
              ancestors,
            )}`
          );
        return `{${entries.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`${path} contains a non-JSON value`);
  }
}

/** Hashes the complete selected query records without depending on input order. */
export function benchmarkQuerySetHash(queries: readonly unknown[]): string {
  const identities = queries.map((query, index) =>
    canonicalJson(query, `$[${index}]`)
  ).sort(compareText);
  return sha256(`[${identities.join(",")}]`);
}

export const benchmarkQuestionSetHash = benchmarkQuerySetHash;

export interface BenchmarkScopeSelection {
  scopeId: string;
}

/** Hashes only the sanitized memory files selected by the current query set. */
export async function benchmarkSelectedCorpusHash(
  sanitizedRoot: string,
  selections: readonly BenchmarkScopeSelection[],
): Promise<string> {
  const scopeIds = [...new Set(selections.map((item, index) => {
    if (typeof item.scopeId !== "string" || item.scopeId.trim().length === 0) {
      throw new TypeError(`selections[${index}].scopeId must be non-empty`);
    }
    return item.scopeId;
  }))].sort(compareText);
  const scopes = await Promise.all(scopeIds.map(async (scopeId) => ({
    scopeId,
    contentHash: createHash("sha256")
      .update(
        await readFile(
          join(sanitizedRoot, safePathSegment(scopeId), "memory.jsonl"),
        ),
      )
      .digest("hex"),
  })));
  return sha256(canonicalJson(scopes));
}

export const benchmarkCorpusHash = benchmarkSelectedCorpusHash;

export interface BenchmarkSourceRevision {
  commit: string;
  dirty: boolean | null;
  fingerprint?: string;
}

export function benchmarkSourceRevision(): BenchmarkSourceRevision {
  const declaredCommit = process.env.PICORER_SOURCE_COMMIT?.trim();
  const declaredDirty = process.env.PICORER_SOURCE_DIRTY?.trim();
  const declaredFingerprint = process.env.PICORER_SOURCE_FINGERPRINT?.trim();
  if (
    declaredCommit !== undefined || declaredDirty !== undefined ||
    declaredFingerprint !== undefined
  ) {
    if (!declaredCommit || !/^[a-f0-9]{40}$/u.test(declaredCommit)) {
      throw new Error("PICORER_SOURCE_COMMIT must be a full lowercase Git SHA");
    }
    if (declaredDirty !== "true" && declaredDirty !== "false") {
      throw new Error("PICORER_SOURCE_DIRTY must be true or false");
    }
    if (
      declaredFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/u.test(declaredFingerprint)
    ) {
      throw new Error("PICORER_SOURCE_FINGERPRINT must be a SHA-256 digest");
    }
    return {
      commit: declaredCommit,
      dirty: declaredDirty === "true",
      ...(declaredFingerprint === undefined
        ? {}
        : { fingerprint: declaredFingerprint }),
    };
  }

  const projectRoot = resolve(import.meta.dirname, "../../..");
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (status.length === 0) return { commit, dirty: false };
    const trackedDiff = execFileSync(
      "git",
      ["diff", "--binary", "HEAD", "--"],
      {
        cwd: projectRoot,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const untrackedOutput = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: projectRoot,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const fingerprint = createHash("sha256")
      .update(status)
      .update("\0")
      .update(trackedDiff);
    for (const relativePath of untrackedOutput
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort(compareText)) {
      fingerprint
        .update("\0")
        .update(relativePath)
        .update("\0")
        .update(readFileSync(resolve(projectRoot, relativePath)));
    }
    return { commit, dirty: true, fingerprint: fingerprint.digest("hex") };
  } catch {
    return { commit: "unavailable", dirty: null };
  }
}

export interface BenchmarkRunManifest {
  schema_version: 1;
  created_at: string;
  config: Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function validateManifest(value: unknown): BenchmarkRunManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Benchmark run manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["schema_version"] !== 1) {
    throw new Error("Benchmark run manifest has an unsupported schema version");
  }
  if (
    typeof record["created_at"] !== "string" ||
    Number.isNaN(Date.parse(record["created_at"]))
  ) {
    throw new Error("Benchmark run manifest has an invalid creation time");
  }
  const config = record["config"];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Benchmark run manifest config must be an object");
  }
  canonicalJson(config, "$.config");
  return {
    schema_version: 1,
    created_at: record["created_at"],
    config: config as Record<string, unknown>,
  };
}

async function createManifestIfAbsent(
  path: string,
  manifest: BenchmarkRunManifest,
): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/** Creates a run manifest once, or validates an existing resumable run. */
export async function ensureBenchmarkRunManifest(
  path: string,
  config: Readonly<Record<string, unknown>>,
): Promise<BenchmarkRunManifest> {
  const expectedConfigIdentity = canonicalJson(config, "$.config");
  const existing = await readJsonFileIfPresent<unknown>(path);
  if (existing !== undefined) {
    const manifest = validateManifest(existing);
    if (canonicalJson(manifest.config, "$.config") !== expectedConfigIdentity) {
      throw new Error(
        "Benchmark output directory has a different run configuration",
      );
    }
    return manifest;
  }

  const manifest: BenchmarkRunManifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    config: JSON.parse(expectedConfigIdentity) as Record<string, unknown>,
  };
  if (await createManifestIfAbsent(path, manifest)) return manifest;

  const raced = await readJsonFileIfPresent<unknown>(path);
  if (raced === undefined) {
    throw new Error("Benchmark run manifest disappeared during creation");
  }
  const validated = validateManifest(raced);
  if (
    canonicalJson(validated.config, "$.config") !== expectedConfigIdentity
  ) {
    throw new Error(
      "Benchmark output directory has a different run configuration",
    );
  }
  return validated;
}

export interface BenchmarkRunInfrastructureMigration {
  schema_version: 1;
  migration_id: string;
  migrated_at: string;
  manifest_created_at: string;
  allowed_config_changes: string[];
  stable_config_hash: string;
  previous_config_hash: string;
  current_config_hash: string;
  changes: Record<string, { before: unknown; after: unknown }>;
}

function withoutTopLevelKeys(
  config: Readonly<Record<string, unknown>>,
  omitted: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !omitted.has(key)),
  );
}

/**
 * Transparently migrates an existing run across infrastructure-only changes.
 *
 * This is deliberately separate from normal resume: callers must opt in and
 * name every top-level field that may change. A durable audit record is written
 * before the manifest is updated, while every other experiment field must stay
 * byte-for-byte identical after canonical JSON normalization.
 */
export async function migrateBenchmarkRunInfrastructure(
  path: string,
  config: Readonly<Record<string, unknown>>,
  allowedConfigChanges: readonly string[],
): Promise<BenchmarkRunManifest> {
  const existingValue = await readJsonFileIfPresent<unknown>(path);
  if (existingValue === undefined) {
    throw new Error(
      "Cannot apply an infrastructure-only migration without a run manifest",
    );
  }
  const existing = validateManifest(existingValue);
  const allowed = new Set(allowedConfigChanges);
  if (allowed.size === 0 || allowed.size !== allowedConfigChanges.length) {
    throw new Error(
      "Infrastructure migration fields must be unique and non-empty",
    );
  }
  for (const key of allowed) {
    if (!key.trim()) {
      throw new Error("Infrastructure migration fields must be non-empty");
    }
  }

  const stableBefore = withoutTopLevelKeys(existing.config, allowed);
  const stableAfter = withoutTopLevelKeys(config, allowed);
  const stableIdentity = canonicalJson(stableBefore, "$.stable_config");
  if (
    canonicalJson(stableAfter, "$.stable_config") !== stableIdentity
  ) {
    throw new Error(
      "Infrastructure-only resume would change the experiment configuration",
    );
  }

  const previousIdentity = canonicalJson(existing.config, "$.previous_config");
  const currentIdentity = canonicalJson(config, "$.current_config");
  if (previousIdentity === currentIdentity) return existing;

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of [...allowed].sort(compareText)) {
    const before = existing.config[key];
    const after = config[key];
    if (
      canonicalJson(before ?? null, `$.changes.${key}.before`) !==
        canonicalJson(after ?? null, `$.changes.${key}.after`)
    ) {
      changes[key] = { before: before ?? null, after: after ?? null };
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("Infrastructure migration has no allowed field changes");
  }

  const migrationId = randomUUID();
  const migrated: BenchmarkRunManifest = {
    schema_version: 1,
    created_at: existing.created_at,
    config: JSON.parse(currentIdentity) as Record<string, unknown>,
  };
  const audit: BenchmarkRunInfrastructureMigration = {
    schema_version: 1,
    migration_id: migrationId,
    migrated_at: new Date().toISOString(),
    manifest_created_at: existing.created_at,
    allowed_config_changes: [...allowed].sort(compareText),
    stable_config_hash: sha256(stableIdentity),
    previous_config_hash: sha256(previousIdentity),
    current_config_hash: sha256(currentIdentity),
    changes,
  };
  await writeAtomicJson(
    join(dirname(path), "execution-migrations", `${migrationId}.json`),
    audit,
  );
  await writeAtomicJson(path, migrated);
  return migrated;
}
