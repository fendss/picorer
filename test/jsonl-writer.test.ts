import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlWriter } from "../src/platform/filesystem/jsonl-writer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("JsonlWriter", () => {
  it("writes concurrent large records as complete JSON lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-jsonl-"));
    temporaryDirectories.push(root);
    const path = join(root, "records.jsonl");
    const writer = new JsonlWriter();
    const values = Array.from({ length: 32 }, (_unused, index) => ({
      index,
      payload: String(index).padStart(2, "0").repeat(50_000),
    }));

    await Promise.all(values.map((value) => writer.append(path, value)));
    await writer.flush();
    const parsed = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { index: number; payload: string });

    expect(parsed).toEqual(values);
  });
});
