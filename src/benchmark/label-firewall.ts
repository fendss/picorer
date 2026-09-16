import type { MemorySessionInput } from "../memory/index.js";

const PRIVATE_LABEL_KEYS = new Set([
  "answer",
  "answerfixed",
  "answersessionids",
  "category",
  "categoryname",
  "evidence",
  "evidenceqid",
  "gold",
  "goldevidence",
  "hasanswer",
  "label",
  "labels",
  "originalquestionid",
  "questionid",
  "questiontype",
]);

function normalizedKey(key: string): string {
  return key.normalize("NFKC").replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
}

function assertNoPrivateLabels(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPrivateLabels(item, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_LABEL_KEYS.has(normalizedKey(key))) {
      throw new Error(`${path} contains private benchmark label: ${key}`);
    }
    assertNoPrivateLabels(child, `${path}.${key}`);
  }
}

/**
 * Benchmark ingress firewall. Core memory accepts domain metadata; benchmark
 * adapters must prove that private labels were removed before ingest.
 */
export function assertBenchmarkLabelFirewall(
  sessions: readonly MemorySessionInput[],
): void {
  for (const [sessionIndex, session] of sessions.entries()) {
    assertNoPrivateLabels(
      session.metadata,
      `sessions[${sessionIndex}].metadata`,
    );
    for (const [turnIndex, turn] of session.turns.entries()) {
      assertNoPrivateLabels(
        turn.metadata,
        `sessions[${sessionIndex}].turns[${turnIndex}].metadata`,
      );
    }
  }
}
