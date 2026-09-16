import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { RewriteWorkingMemory } from "../src/evidence-agent/model/rewrite-working-memory.js";
import {
  createWorkingMemoryContext,
  REWRITE_WORKING_MEMORY_PROMPT,
} from "../src/evidence-agent/adapters/pi/working-memory-context.js";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";

const stub: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read",
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: {} }),
};
const observed: AgentMessage[] = [{
  role: "toolResult",
  toolCallId: "observed",
  toolName: "search",
  content: [{ type: "text", text: "unprocessed candidate" }],
  isError: false,
  timestamp: 1,
}];

describe("single-note rewrite", () => {
  it("replaces the current view and preserves detached before/after audit", () => {
    const note = new RewriteWorkingMemory(() => {});
    note.apply("Established: first relation. Missing: second relation.", "one");
    note.apply("Established: second relation. Missing: none.", "two");
    expect(note.render()).not.toContain("first relation");
    const snapshot = note.snapshot();
    expect(snapshot.history[1]).toMatchObject({
      before: "Established: first relation. Missing: second relation.",
      after: "Established: second relation. Missing: none.",
    });
    snapshot.history.length = 0;
    expect(note.snapshot().history).toHaveLength(2);
    note.apply(null, "three");
    note.apply(undefined, "four");
    note.apply("Established: second relation. Missing: none.", "five");
    expect(note.snapshot().revision).toBe(2);
  });

  it("rejects invalid replacements atomically without silently truncating the note", () => {
    const note = new RewriteWorkingMemory(text => {
      if (text.includes("E999")) throw new Error("Unknown source");
    });
    note.apply("Established: fact. Missing: relation.", "one");
    const before = note.snapshot();
    for (const value of [" ", "x".repeat(1601), [], "E999 says something."]) {
      expect(() => note.apply(value, "invalid")).toThrow();
      expect(note.snapshot()).toEqual(before);
    }
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["identical", "Established: fact. Missing: relation."],
    ["invalid", ""],
  ])("retires preceding results after a successful action when the note is %s", async (_name, value) => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"), 8, "rewrite");
    const read = context.wrapTools([stub])[0]!;
    await read.execute("initial", {
      workingMemory: "Established: fact. Missing: relation.",
    });
    await context.transformContext(observed);
    const result = await read.execute("next", value === undefined ? {} : { workingMemory: value });
    expect(result.details.workingMemoryUpdate.acknowledgedToolCallIds).toEqual(["observed"]);
    expect(JSON.stringify(await context.transformContext(observed))).not.toContain("unprocessed candidate");
    expect(context.workingMemorySnapshot()).toMatchObject({
      note: "Established: fact. Missing: relation.",
      revision: 1,
    });
    if (value === "") {
      expect(result.details.workingMemoryUpdate).toMatchObject({ rejected: true });
    }
  });

  it("keeps the prior results and note when the native action fails", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"), 8, "rewrite");
    const read = context.wrapTools([stub])[0]!;
    await read.execute("initial", {
      workingMemory: "Established: fact. Missing: relation.",
    });
    await context.transformContext(observed);
    const failing = context.wrapTools([{
      ...stub,
      execute: async () => {
        throw new Error("read unavailable");
      },
    }])[0]!;
    await expect(failing.execute("failed", {
      workingMemory: "Established: changed. Missing: none.",
    })).rejects.toThrow("read unavailable");
    expect(context.workingMemorySnapshot()).toMatchObject({
      note: "Established: fact. Missing: relation.",
      revision: 1,
    });
    expect(JSON.stringify(await context.transformContext(observed))).toContain("unprocessed candidate");
  });

  it("keeps source-like prose non-authoritative and gives the model a plain-state contract", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"), 8, "rewrite");
    const read = context.wrapTools([stub])[0]!;
    await read.execute("note", {
      workingMemory: "Established: a claim mentioning C999. Missing: verification.",
    });
    expect(context.workingMemorySnapshot()).toMatchObject({ revision: 1 });
    expect(REWRITE_WORKING_MEMORY_PROMPT).toContain("Established:");
    expect(REWRITE_WORKING_MEMORY_PROMPT).toContain("Missing:");
    expect(REWRITE_WORKING_MEMORY_PROMPT).toContain("Do not put candidate handles");
    const schema = JSON.stringify(read.parameters);
    expect(schema).toContain("Do not include source handles");
    expect(schema).not.toContain("supporting E handles");
  });
});
