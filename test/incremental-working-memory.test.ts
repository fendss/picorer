import { describe, expect, it } from "vitest";
import { IncrementalWorkingMemory, WORKING_MEMORY_MAX_CHARS } from "../src/evidence-agent/model/working-memory.js";

const create = () => new IncrementalWorkingMemory((text) => {
  if (text.includes("E999")) throw new Error("Unknown evidence reference");
});

describe("incremental working memory", () => {
  it("keeps the first relation when adding the next relation from the Q3 failure", () => {
    const memory = create();
    memory.apply([{ op: "add", text: 'C5, fact 6274: Your Hit Parade was first broadcast by NBC.' }], "first-hop");
    memory.apply([{ op: "add", text: 'E1 from C16, fact 8147: NBC was founded in Paris.' }], "second-hop");
    expect(memory.snapshot().entries.map((e) => e.id)).toEqual(["W1", "W2"]);
    expect(memory.render()).toContain("Your Hit Parade");
    expect(memory.render()).toContain("Paris");
    expect(memory.snapshot().history[1]!.changes).toHaveLength(1);
  });

  it("updates and retires only named entries and keeps old values in the audit", () => {
    const memory = create();
    memory.apply([{ op: "add", text: "Lives in Paris, from C1." }, { op: "add", text: "Works as a teacher, from C2." }], "a");
    memory.apply([{ op: "update", id: "W1", text: "Now lives in Berlin, from C3." }], "b");
    expect(memory.snapshot().entries[1]!.text).toBe("Works as a teacher, from C2.");
    memory.apply([{ op: "retire", id: "W1", reason: "Residence is outside this task." }], "c");
    expect(memory.snapshot().entries).toEqual([{ id: "W2", text: "Works as a teacher, from C2." }]);
    expect(memory.snapshot().history[1]!.changes[0]).toMatchObject({ before: "Lives in Paris, from C1.", after: "Now lives in Berlin, from C3." });
    expect(memory.snapshot().history[2]!.changes[0]).toMatchObject({ before: "Now lives in Berlin, from C3.", reason: "Residence is outside this task." });
    expect(() => memory.apply([{ op: "update", id: "W1", text: "Revive an old entry" }], "d")).toThrow("retired");
    expect(memory.apply([{ op: "add", text: "A different fact" }], "e").changes[0]!.id).toBe("W3");
  });

  it.each([
    [{ op: "add", text: "new" }, { op: "update", id: "W99", text: "missing" }],
    [{ op: "retire", id: "W1", reason: "remove" }, { op: "add", text: "E999 is not a source" }],
    [{ op: "update", id: "W1", text: "first" }, { op: "retire", id: "W1", reason: "second" }],
    [{ op: "add", text: "new" }, { op: "update", id: "W2", text: "guessed new ID" }],
    [{ op: "add", text: "new", unexpected: true }],
  ])("rejects the entire invalid patch without losing old entries or consuming IDs: %j", (...operations) => {
    const memory = create();
    memory.apply([{ op: "add", text: "old" }], "a");
    const before = memory.snapshot();
    expect(() => memory.apply(operations, "bad")).toThrow();
    expect(memory.snapshot()).toEqual(before);
    expect(memory.apply([{ op: "add", text: "valid next fact" }], "b").changes[0]!.id).toBe("W2");
  });

  it("rejects whole-note replacement and never evicts entries on overflow", () => {
    const memory = create();
    memory.apply([{ op: "add", text: "x".repeat(WORKING_MEMORY_MAX_CHARS) }], "a");
    const before = memory.snapshot();
    expect(() => memory.apply("A replacement note", "bad")).toThrow("whole-note");
    expect(() => memory.apply([{ op: "add", text: "extra" }], "overflow")).toThrow("Nothing was changed");
    expect(memory.snapshot()).toEqual(before);
    memory.apply([{ op: "add", text: "new fact" }, { op: "retire", id: "W1", reason: "Explicitly resolved." }], "b");
    expect(memory.snapshot().entries).toEqual([{ id: "W2", text: "new fact" }]);
    expect(memory.snapshot().history[1]!.changes[1]).toMatchObject({ before: "x".repeat(WORKING_MEMORY_MAX_CHARS) });
  });

  it("treats null and an empty patch as unchanged and exposes detached snapshots", () => {
    const memory = create();
    memory.apply([{ op: "add", text: "retain" }], "a");
    const before = memory.snapshot();
    memory.apply(null, "b"); memory.apply([], "c");
    expect(memory.snapshot()).toEqual(before);
    const copy = memory.snapshot(); copy.entries[0]!.text = "tampered"; copy.history.length = 0;
    expect(memory.snapshot()).toEqual(before);
  });
});
