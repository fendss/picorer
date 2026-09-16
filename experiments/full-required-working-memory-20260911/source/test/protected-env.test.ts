import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProtectedEnvironment,
  requireEnvironmentVariable,
} from "../src/platform/security/protected-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

describe("protected environments", () => {
  it("sources mode-0600 files without logging their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-env-"));
    roots.push(root);
    const path = join(root, "answer.env");
    await writeFile(path, "SUITE_TEST_VALUE='value with spaces'\n", { mode: 0o600 });

    const loaded = await loadProtectedEnvironment([path], { PATH: process.env.PATH });

    expect(loaded["SUITE_TEST_VALUE"]).toBe("value with spaces");
    expect(requireEnvironmentVariable(loaded, "SUITE_TEST_VALUE")).toBe(
      "value with spaces",
    );
  });

  it("rejects an environment file with broad permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-env-"));
    roots.push(root);
    const path = join(root, "answer.env");
    await writeFile(path, "SUITE_TEST_VALUE=value\n", { mode: 0o600 });
    await chmod(path, 0o644);

    await expect(loadProtectedEnvironment([path])).rejects.toThrow(/0600/u);
  });
});
