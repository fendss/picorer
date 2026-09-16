import { describe, expect, it } from "vitest";
import { scopedQdrantGenerationId } from "../src/composition/scoped-qdrant-retrieval.js";
import type { MemoryRecord } from "../src/memory/index.js";

function record(memoryId: string, contentHash: string): MemoryRecord {
  return {
    memoryId,
    scopeId: "scope-a",
    sessionId: "session-a",
    turnIndex: 0,
    role: "user",
    content: "not part of the generation identity",
    contentHash,
    metadata: {},
  };
}

describe("scoped Qdrant generations", () => {
  it("is stable across record order and changes with corpus content", () => {
    const first = scopedQdrantGenerationId(
      "online-run",
      "scope-a",
      [record("memory-a", "hash-a"), record("memory-b", "hash-b")],
    );
    expect(first).toBe(scopedQdrantGenerationId(
      "online-run",
      "scope-a",
      [record("memory-b", "hash-b"), record("memory-a", "hash-a")],
    ));
    expect(first).not.toBe(scopedQdrantGenerationId(
      "online-run",
      "scope-a",
      [record("memory-a", "hash-a"), record("memory-b", "hash-new")],
    ));
    expect(first.length).toBeLessThanOrEqual(512);
  });

  it("rejects empty and mixed scopes", () => {
    expect(() => scopedQdrantGenerationId("online-run", "scope-a", []))
      .toThrow(/empty or mixed/u);
    expect(() => scopedQdrantGenerationId("online-run", "scope-b", [
      record("memory-a", "hash-a"),
    ])).toThrow(/empty or mixed/u);
  });
});
