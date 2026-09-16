import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  SearchOperator,
  SearchOperatorPluginModule,
  SearchOperatorStore,
} from "../retrieval/index.js";

export interface LoadedSearchOperatorPlugins {
  operators: SearchOperator[];
  modules: Array<{
    name: string;
    path: string;
    sha256: string;
  }>;
}

function pluginModule(value: unknown, path: string): SearchOperatorPluginModule {
  if (
    typeof value !== "object" || value === null ||
    !("createSearchOperators" in value) ||
    typeof value.createSearchOperators !== "function"
  ) {
    throw new TypeError(
      `Search-operator plugin ${path} must export createSearchOperators(store)`,
    );
  }
  return value as SearchOperatorPluginModule;
}

/** Loads trusted local modules once at composition time and fingerprints them. */
export async function loadSearchOperatorPlugins(
  paths: readonly string[],
  store: SearchOperatorStore,
): Promise<LoadedSearchOperatorPlugins> {
  const operators: SearchOperator[] = [];
  const modules: LoadedSearchOperatorPlugins["modules"] = [];
  for (const rawPath of paths) {
    const path = resolve(rawPath);
    const source = await readFile(path);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const imported = pluginModule(
      await import(`${pathToFileURL(path).href}?sha256=${sha256}`),
      path,
    );
    const created = await imported.createSearchOperators(store);
    const createdOperators = Array.isArray(created) ? [...created] : [created];
    if (createdOperators.length === 0) {
      throw new Error(`Search-operator plugin ${path} returned no operators`);
    }
    operators.push(...createdOperators);
    modules.push({ name: basename(path), path, sha256 });
  }
  return { operators, modules };
}
