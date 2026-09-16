import { describe, expect, it } from "vitest";
import { buildBashRoDockerArgs, ReadOnlyBash } from "../src/evidence-agent/adapters/docker/read-only-shell.js";

describe("read-only bash sandbox", () => {
  it("builds a networkless, least-privilege, read-only container", () => {
    const args = buildBashRoDockerArgs(
      "/safe/scope",
      "grep -n Miso memory.jsonl",
      "python:3.12-slim",
      "65534:65534",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65534:65534",
      ]),
    );
    expect(args).toContain(
      "type=bind,src=/safe/scope,dst=/memory,readonly",
    );
    expect(args.at(-1)).toBe("grep -n Miso memory.jsonl");
  });

  it("rejects invalid commands before starting Docker", async () => {
    const runner = new ReadOnlyBash({ dockerBinary: "must-not-run" });
    await expect(runner.run("/not/used", "")).rejects.toThrow(/must not be empty/u);
    await expect(
      runner.run("/not/used", `x${"\0"}y`),
    ).rejects.toThrow(/invalid or too long/u);
  });
});
