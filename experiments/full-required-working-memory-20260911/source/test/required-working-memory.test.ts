import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createRequiredWorkingMemory } from "../src/evidence-agent/adapters/pi/required-working-memory.js";
import { createMemoryObservation } from "../src/evidence-agent/adapters/pi/memory-observation.js";
import { createEphemeralMemoryContext } from "../src/evidence-agent/adapters/pi/ephemeral-context.js";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";

const messages: AgentMessage[] = [{ role: "toolResult", toolCallId: "s1", toolName: "search",
  content: [{ type: "text", text: "source fact" }], isError: false, timestamp: 1 }];
function fixture(name = "search") {
  const observation = createMemoryObservation({ ledger: new MemoryLedger("scope") });
  const policy = createRequiredWorkingMemory(observation);
  const execute = vi.fn<AgentTool["execute"]>(async () => ({ content: [], details: { kept: true } }));
  const native: AgentTool = { name, label: name, description: name,
    parameters: Type.Object({ query: Type.Optional(Type.String()) }), execute };
  const tool = policy.wrapTools([native])[0]!;
  return { observation, policy, execute, tool };
}

describe("full required working memory", () => {
  it("allows initial omission but rejects omission after observation before running native work", async () => {
    const { policy, tool, execute } = fixture();
    await tool.execute("s1", { query: "entity" });
    policy.observe(messages);
    await expect(tool.execute("s2", { query: "relation" })).rejects.toThrow("required");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("requires an initial note and permits explicit unchanged only after one exists", async () => {
    const { policy, tool, observation } = fixture();
    policy.observe(messages);
    await expect(tool.execute("a", { workingMemory: null })).rejects.toThrow("No workingMemory");
    await tool.execute("b", { workingMemory: "Established: A. Missing: B." });
    const result = await tool.execute("c", { workingMemory: null });
    expect(result.details.requiredWorkingMemory).toMatchObject({ mode: "confirmed", note: "Established: A. Missing: B." });
    expect(observation.render()).toContain("Established: A. Missing: B.");
  });
  it("rejects blank and oversized notes atomically and removes only the note argument", async () => {
    const { tool, observation, execute } = fixture();
    await tool.execute("a", { workingMemory: "current", query: "relation" });
    for (const note of [" ", "a".repeat(1601)]) {
      await expect(tool.execute("b", { workingMemory: note })).rejects.toThrow();
    }
    expect(observation.render()).toContain("current");
    expect(execute.mock.calls).toHaveLength(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ query: "relation" });
  });
  it("requires confirmation at finish and persists replacement in the same observation", async () => {
    const { tool, observation } = fixture("finish");
    await expect(tool.execute("a", {})).rejects.toThrow("required");
    const result = await tool.execute("b", { workingMemory: "Established: A. Missing: none." });
    expect(result.details.kept).toBe(true);
    expect(observation.render()).toContain("Established: A. Missing: none.");
  });
  it("does not mistake same-batch execution for an observed result or compact history", async () => {
    const { policy, tool } = fixture();
    await tool.execute("a", {});
    await tool.execute("b", {});
    const before = structuredClone(messages);
    const context = createEphemeralMemoryContext();
    const expected = await context.transformContext(messages);
    policy.observe(messages);
    expect(await context.transformContext(messages)).toEqual(expected);
    expect(messages).toEqual(before);
  });
  it("keeps the native full pre-action note commit when the subsequent tool fails", async () => {
    const { policy, observation } = fixture();
    const failing: AgentTool = { name: "read", label: "read", description: "read",
      parameters: Type.Object({}), execute: async () => { throw new Error("source unavailable"); } };
    const tool = policy.wrapTools([failing])[0]!;
    await expect(tool.execute("f", { workingMemory: "still missing B" })).rejects.toThrow("source unavailable");
    expect(observation.render()).toContain("still missing B");
  });
});
