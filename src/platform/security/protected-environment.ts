import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

function sourceFiles(
  paths: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve, reject) => {
    const script = [
      "set -a",
      'for file do . "$file" || exit; done',
      "env -0",
    ].join("; ");
    execFile(
      "/bin/sh",
      ["-c", script, "picorer-protected-env", ...paths],
      {
        encoding: "utf8",
        env: environment,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Unable to load protected environment file"));
          return;
        }
        const loaded: NodeJS.ProcessEnv = {};
        for (const entry of stdout.split("\0")) {
          if (!entry) continue;
          const separator = entry.indexOf("=");
          if (separator <= 0) continue;
          loaded[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
        resolve(loaded);
      },
    );
  });
}

export async function loadProtectedEnvironment(
  paths: readonly string[],
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (paths.length === 0) return { ...baseEnvironment };
  for (const path of paths) {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Protected environment file must be a mode-0600 file");
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error("Protected environment file must be owned by the runner");
    }
  }
  return sourceFiles(paths, { ...baseEnvironment });
}

export function requireEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
    throw new Error("Environment variable name is invalid");
  }
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable is missing: ${name}`);
  }
  return value;
}
