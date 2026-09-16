import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import type {
  ReadOnlyNavigation,
  ReadOnlyNavigationResult,
} from "../../ports/read-only-navigation.js";

const DEFAULT_IMAGE = "dockerproxy.com/library/python:3.12-slim";
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

export type BashRoResult = ReadOnlyNavigationResult;

export interface BashRoOptions {
  dockerBinary?: string;
  image?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  containerUser?: string;
}

export function buildBashRoDockerArgs(
  scopePath: string,
  command: string,
  image = DEFAULT_IMAGE,
  containerUser = "0:0",
): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--ulimit",
    "cpu=10:10",
    "--user",
    containerUser,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=32m",
    "--mount",
    `type=bind,src=${scopePath},dst=/memory,readonly`,
    "--workdir",
    "/memory",
    image,
    "/bin/sh",
    "-lc",
    command,
  ];
}

/**
 * Runs a shell inside a disposable, networkless container with exactly one
 * sanitized memory scope mounted read-only. It never invokes a host shell.
 */
export class ReadOnlyBash implements ReadOnlyNavigation {
  private readonly dockerBinary: string;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly containerUser: string;

  constructor(options: BashRoOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.image = options.image ?? DEFAULT_IMAGE;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // Docker bind mounts on the target server are owned by root inside the
    // container even when the host files belong to the invoking UID. Root is
    // confined by a read-only rootfs/mount, no network, no capabilities and
    // no-new-privileges.
    this.containerUser = options.containerUser ?? "0:0";
  }

  async run(
    scopePath: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<BashRoResult> {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("bash_ro command must not be empty");
    }
    if (command.includes("\0") || command.length > 4096) {
      throw new Error("bash_ro command is invalid or too long");
    }
    if (signal?.aborted) {
      throw new Error("bash_ro aborted");
    }

    const resolvedScopePath = await realpath(scopePath);
    const scopeStats = await stat(resolvedScopePath);
    if (!scopeStats.isDirectory()) {
      throw new Error("bash_ro scope path must be a directory");
    }

    const args = buildBashRoDockerArgs(
      resolvedScopePath,
      command,
      this.image,
      this.containerUser,
    );
    return new Promise<BashRoResult>((resolve, reject) => {
      const child = spawn(this.dockerBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let outputBytes = 0;
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const stop = (): void => {
        if (!child.killed) child.kill("SIGKILL");
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = Math.max(0, this.maxOutputBytes - outputBytes);
        const kept = chunk.subarray(0, remaining);
        if (target === "stdout") {
          stdout = Buffer.concat([stdout, kept]);
        } else {
          stderr = Buffer.concat([stderr, kept]);
        }
        outputBytes += kept.length;
        if (kept.length < chunk.length || outputBytes >= this.maxOutputBytes) {
          truncated = true;
          stop();
        }
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.timeoutMs);
      timer.unref();

      const abort = (): void => {
        aborted = true;
        stop();
      };
      signal?.addEventListener("abort", abort, { once: true });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new Error(`Unable to start bash_ro container: ${error.message}`));
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (aborted) {
          reject(new Error("bash_ro aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`bash_ro timed out after ${this.timeoutMs}ms`));
          return;
        }
        resolve({
          command,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          exitCode,
          truncated,
        });
      });
    });
  }
}
