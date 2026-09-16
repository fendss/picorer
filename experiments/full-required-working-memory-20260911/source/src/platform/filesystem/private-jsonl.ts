import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PrivateJsonlIdentity<T> {
  label: string;
  key(record: T): string;
}

export async function readPrivateJsonl<T>(path: string): Promise<T[]> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return serialized
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function mergePrivateJsonl<T>(
  path: string,
  incoming: readonly T[],
  identity: PrivateJsonlIdentity<T>,
): Promise<void> {
  const records = new Map<string, T>();
  for (const record of await readPrivateJsonl<T>(path)) {
    records.set(identity.key(record), record);
  }
  for (const record of incoming) {
    const key = identity.key(record).trim();
    if (!key) throw new Error(`Private ${identity.label} must not be empty`);
    const existing = records.get(key);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Private record changed for immutable ${identity.label} ${key}`);
    }
    records.set(key, record);
  }

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  const serialized = [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => JSON.stringify(record))
    .join("\n") + "\n";
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}
