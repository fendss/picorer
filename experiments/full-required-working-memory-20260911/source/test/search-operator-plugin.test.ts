import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelectedSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import { loadSearchOperatorPlugins } from "../src/composition/load-search-operator-plugins.js";
import type { SearchOperatorStore } from "../src/retrieval/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function pluginFile(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picorer-operator-plugin-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fixture-operator.mjs");
  await writeFile(path, source, "utf8");
  return path;
}

describe("deploy-time search-operator plugins", () => {
  it("loads, fingerprints, and registers a local operator without core edits", async () => {
    const path = await pluginFile(`
export function createSearchOperators() {
  return {
    id: "fixture-exact",
    version: "1",
    guide: {
      summary: "Fixture exact lookup.",
      useWhen: ["A fixture anchor is available."],
      avoidWhen: ["No fixture anchor is available."],
      cost: "low"
    },
    async execute(_context, input) {
      return {
        request: { queries: [...input.queries], limit: input.limit, order: "relevance" },
        hits: []
      };
    }
  };
}
`);
    const store: SearchOperatorStore = { search: () => [] };
    const loaded = await loadSearchOperatorPlugins([path], store);
    const registry = createSelectedSearchOperatorRegistry(
      store,
      ["lexical"],
      loaded.operators,
    );

    expect(registry.list().map((entry) => entry.id)).toEqual([
      "lexical",
      "fixture-exact",
    ]);
    expect(loaded.modules).toEqual([{
      name: "fixture-operator.mjs",
      path,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]);
  });

  it("rejects modules that do not expose the narrow factory contract", async () => {
    const path = await pluginFile("export const unrelated = true;\n");
    await expect(loadSearchOperatorPlugins([path], { search: () => [] }))
      .rejects.toThrow(/must export createSearchOperators/u);
  });
});
