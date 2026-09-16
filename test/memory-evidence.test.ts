import { describe, expect, it } from "vitest";
import {
  MAX_READ_RESULT_CHARS,
  projectMemoryEvidence,
  projectMemoryEvidenceBatch,
} from "../src/evidence-agent/index.js";
import type { MemoryRecord } from "../src/memory/index.js";
import { sha256 } from "../src/util.js";

function record(content: string, memoryId = "m-large"): MemoryRecord {
  return {
    memoryId,
    scopeId: "scope-1",
    sessionId: "session-1",
    turnIndex: 0,
    role: "other",
    content,
    contentHash: sha256(content),
    metadata: {},
  };
}

describe("bounded memory evidence", () => {
  it.each([
    [17_000, 16_000, 18_000],
    [60_000, 500, 1_000],
    [MAX_READ_RESULT_CHARS],
    [MAX_READ_RESULT_CHARS - 2, 2, 0],
  ])("preserves complete sources when batch lengths %j fit, regardless of per-parent size", (...lengths) => {
    const records = lengths.map((length, i) => record("x".repeat(length), `m-${i}`));
    const evidence = projectMemoryEvidenceBatch(records, () => ["unmatched query"]);
    expect(evidence.map(e => e.content)).toEqual(records.map(r => r.content));
    expect(evidence.every(e => !e.truncated && e.contentHash === e.sourceContentHash)).toBe(true);
  });

  it("uses the caller's remaining batch budget including previously reserved passage space", () => {
    const source = record("🙂".repeat(5_000));
    const exact = projectMemoryEvidenceBatch([source], () => [], 10_000);
    expect(exact[0]!.content).toBe(source.content);
    const bounded = projectMemoryEvidenceBatch([source], () => [], 9_999);
    expect(bounded[0]!.truncated).toBe(true);
    expect(bounded[0]!.content.length).toBeLessThanOrEqual(9_999);
  });

  it("preserves required spans beyond the old parent cap and still validates their offsets", () => {
    const source = record("x".repeat(20_000));
    const evidence = projectMemoryEvidenceBatch([source], () => [], 20_000,
      () => [{ start: 2_000, end: 15_000 }]);
    expect(evidence[0]!.content).toBe(source.content);
    expect(() => projectMemoryEvidenceBatch([source], () => [], 20_000,
      () => [{ start: -1, end: 15_000 }])).toThrow(/Invalid required source span/);
  });

  it("keeps the existing bounded fallback when the complete batch exceeds the total limit", () => {
    const records = Array.from({ length: 4 }, (_, i) => record("x".repeat(20_000), `m-${i}`));
    const evidence = projectMemoryEvidenceBatch(records, () => []);
    expect(evidence.every(e => e.truncated && e.content.length <= 8_192)).toBe(true);
    expect(evidence.reduce((sum, e) => sum + e.content.length, 0)).toBeLessThanOrEqual(MAX_READ_RESULT_CHARS);
  });

  it("spends the excerpt budget on unique source positions instead of overlapping windows", () => {
    const source = record(`${"_".repeat(2500)}targetOne targetOne${"_".repeat(12000)}targetTwo${"_".repeat(12000)}`);
    const evidence = projectMemoryEvidence(source, ["targetOne targetTwo"], 8192);
    expect(evidence.content).toContain("targetOne");
    expect(evidence.content).toContain("targetTwo");
    expect(evidence.excerpts.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(8192);
    for (const excerpt of evidence.excerpts) {
      expect(source.content.slice(excerpt.start, excerpt.end)).toBe(excerpt.content);
    }
  });

  it("keeps small source memories byte-exact", () => {
    const source = record("Step 1:\nAction: inspect\nObservation: blue key");
    const evidence = projectMemoryEvidence(source, ["blue key"], 4_096);

    expect(evidence.content).toBe(source.content);
    expect(evidence.truncated).toBe(false);
    expect(evidence.sourceContentHash).toBe(source.contentHash);
    expect(evidence.excerpts).toEqual([{
      start: 0,
      end: source.content.length,
      content: source.content,
    }]);
  });

  it("finds an exact focused passage inside an oversized source", () => {
    const target = "The World Bank indicator request completed successfully.";
    const content = `Step 5:\nAction: retrieve indicator\n${"x".repeat(300_000)}${target}${"y".repeat(300_000)}`;
    const source = record(content);
    const evidence = projectMemoryEvidence(
      source,
      ["World Bank indicator completed successfully"],
      8_192,
    );

    expect(evidence.truncated).toBe(true);
    expect(evidence.content).toContain(target);
    expect(evidence.content.length).toBeLessThan(9_000);
    expect(evidence.excerpts.reduce((sum, excerpt) => sum + excerpt.content.length, 0))
      .toBeLessThanOrEqual(8_192);
    for (const excerpt of evidence.excerpts) {
      expect(source.content.slice(excerpt.start, excerpt.end)).toBe(excerpt.content);
    }
  });

  it("bounds a large multi-candidate read batch", () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      record(
        `Step ${String(index)}:\n${"noise ".repeat(40_000)}target-${String(index)}`,
        `m-${String(index)}`,
      )
    );
    const evidence = projectMemoryEvidenceBatch(records, (item) => [
      `target-${item.memoryId.slice(2)}`,
    ]);
    const exactChars = evidence.flatMap((item) => item.excerpts)
      .reduce((sum, excerpt) => sum + excerpt.content.length, 0);
    const renderedChars = evidence.reduce((sum, item) => sum + item.content.length, 0);

    expect(exactChars).toBeLessThanOrEqual(MAX_READ_RESULT_CHARS);
    expect(renderedChars).toBeLessThanOrEqual(MAX_READ_RESULT_CHARS);
    expect(evidence.every((item) => item.truncated)).toBe(true);
  });

  it("reserves the caller's remaining read budget including omission markers", () => {
    const records = [record("x".repeat(20_000))];
    const evidence = projectMemoryEvidenceBatch(records, () => [], 2_000);
    expect(evidence[0]!.content.length).toBeLessThanOrEqual(2_000);
    expect(evidence[0]!.excerpts.length).toBeGreaterThan(0);
  });

  it("keeps exact excerpts within the batch budget beyond 256 memories", () => {
    const records = Array.from({ length: 300 }, (_, index) =>
      record(
        `${"head ".repeat(2_000)}target-${String(index)}`,
        `m-wide-${String(index)}`,
      )
    );
    const evidence = projectMemoryEvidenceBatch(records, () => ["target"]);
    const exactChars = evidence.flatMap((item) => item.excerpts)
      .reduce((sum, excerpt) => sum + excerpt.content.length, 0);

    expect(evidence).toHaveLength(records.length);
    expect(exactChars).toBeLessThanOrEqual(MAX_READ_RESULT_CHARS);
    expect(evidence.every((item) => item.truncated)).toBe(true);
    expect(evidence.every((item) => item.content.includes("target-"))).toBe(true);
  });
});
