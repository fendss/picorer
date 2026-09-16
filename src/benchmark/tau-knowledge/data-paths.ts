import { resolve } from "node:path";

export interface TauKnowledgeDataPaths {
  root: string;
  database: string;
  sanitized: string;
  manifest: string;
}

export function tauKnowledgeDataPaths(root: string): TauKnowledgeDataPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    database: resolve(resolved, "memory.sqlite"),
    sanitized: resolve(resolved, "sanitized"),
    manifest: resolve(resolved, "tau-knowledge-manifest.json"),
  };
}
