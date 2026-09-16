import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Writes a file through a permission-restricted temporary file and atomic rename. */
export async function writeAtomicText(
  path: string,
  serialized: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

/** Serializes a value as formatted JSON and writes it atomically. */
export async function writeAtomicJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writeAtomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface AtomicTextFile {
  append(serialized: string): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

/** Opens a restricted temporary file for bounded-memory artifact materialization. */
export async function createAtomicTextFile(
  path: string,
): Promise<AtomicTextFile> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let state: "open" | "committed" | "aborted" = "open";
  const closeAndRemove = async (): Promise<void> => {
    try {
      await handle.close();
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  };
  return {
    append: async (serialized) => {
      if (state !== "open") throw new Error("Atomic text file is not open");
      await handle.write(serialized);
    },
    commit: async () => {
      if (state !== "open") throw new Error("Atomic text file is not open");
      await handle.sync();
      await handle.close();
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      state = "committed";
    },
    abort: async () => {
      if (state !== "open") return;
      state = "aborted";
      await closeAndRemove();
    },
  };
}

/** Reads a JSON file, returning undefined only when the file is absent. */
export async function readJsonFileIfPresent<T>(
  path: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Executes a command used to create an archive and normalizes its error. */
export async function executeArchiveCommand(
  file: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error) => {
        if (error) {
          reject(new Error(`Unable to create benchmark archive with ${file}`));
          return;
        }
        resolvePromise();
      },
    );
  });
}
