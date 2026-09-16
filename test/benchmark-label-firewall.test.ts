import { describe, expect, it } from "vitest";
import { assertBenchmarkLabelFirewall } from "../src/benchmark/index.js";
import type { MemorySessionInput } from "../src/memory/index.js";

function session(metadata: Record<string, unknown>): MemorySessionInput {
  return {
    scopeId: "scope-1",
    sessionId: "session-1",
    metadata,
    turns: [{ role: "user", content: "source memory" }],
  };
}

describe("benchmark label firewall", () => {
  it("rejects normalized private-label keys at benchmark ingress", () => {
    expect(() => assertBenchmarkLabelFirewall([
      session({ nested: [{ "Gold Evidence": ["secret"] }] }),
    ])).toThrow(/private benchmark label: Gold Evidence/u);
  });

  it("checks turn metadata as well as session metadata", () => {
    const input = session({ source: "public" });
    input.turns[0]!.metadata = { answer_fixed: "secret" };
    expect(() => assertBenchmarkLabelFirewall([input])).toThrow(
      /private benchmark label: answer_fixed/u,
    );
  });

  it("accepts ordinary source metadata", () => {
    expect(() => assertBenchmarkLabelFirewall([
      session({ source: "official", eventType: "purchase", ordinal: 2 }),
    ])).not.toThrow();
  });
});
