import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";
import { createRewriteWorkingMemoryContext } from "../src/evidence-agent/adapters/pi/rewrite-working-memory-context.js";
import { createWorkingMemoryObservation } from "../src/evidence-agent/adapters/pi/working-memory-observation.js";
import { renderReadReceipts } from "../src/evidence-agent/adapters/pi/read-receipts.js";
import { projectMemoryEvidence } from "../src/evidence-agent/model/source-evidence.js";
import { compactPreview, sha256 } from "../src/util.js";
import type { MemoryRecord } from "../src/memory/index.js";

const memory = (id: string, content: string): MemoryRecord => ({
  memoryId: id, scopeId: "visibility", sessionId: "session", turnIndex: 0,
  role: "user", timestamp: "2023-01-01", content, contentHash: sha256(content), metadata: {},
});
const add = (ledger: MemoryLedger, record: MemoryRecord, query = "badge number") =>
  ledger.recordSearchHits([{ record, query, retriever: "fts5", rank: 1, score: 1, preview: record.content }]);
const message = (id: string, content: string): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: "search", isError: false,
  content: [{ type: "text", text: content }], timestamp: 1,
});

describe("source visibility across context retirement", () => {
  it("re-exposes the same candidate after its previous result leaves the actual context", async () => {
    const ledger = new MemoryLedger("visibility");
    const findings = add(ledger, memory("known", "My badge number is ZX-83."));
    const context = createRewriteWorkingMemoryContext(ledger, 8);
    const native: AgentTool = { name: "search", label: "Search", description: "Search",
      parameters: Type.Object({}), execute: async () => {
        context.observation.recordSearch({ findingCount: 1, findings });
        return { content: [{ type: "text", text: context.observation.render() }], details: {} };
      } };
    const tool = context.wrapTools([native])[0]!;
    await context.transformContext([]);
    const first = await tool.execute("s1", {});
    const firstMessage = message("s1", first.content.map(c => c.type === "text" ? c.text : "").join(""));
    await context.transformContext([firstMessage]);
    const second = await tool.execute("s2", { workingMemory: "Still investigating the badge number." });
    const secondMessage = message("s2", second.content.map(c => c.type === "text" ? c.text : "").join(""));
    const output = await context.transformContext([firstMessage, secondMessage]);
    expect(output.some(m => m.role === "toolResult" && m.toolCallId === "s1")).toBe(false);
    const visible = output.find(m => m.role === "toolResult" && m.toolCallId === "s2");
    expect(JSON.stringify(visible)).toContain("read C1");
    expect(JSON.stringify(visible)).toContain("ZX-83");
    expect(ledger.resolveCandidateRefs(["C1"])).toEqual(["known"]);
  });

  it("lets the harness retire a result when the submitted note is identical", async () => {
    const context = createRewriteWorkingMemoryContext(new MemoryLedger("visibility"), 8);
    const native: AgentTool = { name: "search", label: "Search", description: "Search",
      parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
    const tool = context.wrapTools([native])[0]!;
    await tool.execute("init", { workingMemory: "Still investigating." });
    const previous = [message("s1", "The candidate establishes ZX-83.")];
    await context.transformContext(previous);
    const result = await tool.execute("s2", { workingMemory: "Still investigating." });
    expect(result.details.workingMemoryUpdate.acknowledgedToolCallIds).toEqual(["s1"]);
    expect(JSON.stringify(await context.transformContext(previous))).not.toContain("establishes ZX-83");
  });

  it("retains actual read receipts after a changed note drops or contradicts the fact", async () => {
    const ledger = new MemoryLedger("visibility");
    const source = memory("read", "My badge number is ZX-83.");
    add(ledger, source);
    add(ledger, memory("unread", "This unread candidate has a different badge."));
    ledger.recordInspect([projectMemoryEvidence(source, [], 8192)], undefined, ["read"]);
    const context = createRewriteWorkingMemoryContext(ledger, 8);
    const native: AgentTool = { name: "search", label: "Search", description: "Search",
      parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
    const tool = context.wrapTools([native])[0]!;
    const previous = [message("read-result", "The original read payload.")];
    await context.transformContext(previous);
    await tool.execute("s2", { workingMemory: "I have not read the badge number. C2 might help." });
    const output = JSON.stringify(await context.transformContext(previous));
    expect(output).not.toContain("The original read payload.");
    expect(output).toContain("C1 · read · user");
    expect(output).toContain("ZX-83");
    expect(renderReadReceipts(ledger)).not.toContain("C2");
    expect(ledger.inspectedEvidence).toHaveLength(1);
  });

  it("preserves the query-bearing tail and role in the compact directory", () => {
    const ledger = new MemoryLedger("visibility");
    const prefix = "A long unrelated introduction about the office. ".repeat(5);
    const source = memory("tail", prefix + "The badge number is ZX-83. Please retain this identifier.");
    const findings = add(ledger, source);
    expect(compactPreview(source.content, 128)).not.toContain("ZX-83");
    const observation = createWorkingMemoryObservation(ledger, 8, { refreshResults: true });
    observation.recordSearch({ findingCount: 0, findings: [], directoryFindings: findings });
    const text = observation.render();
    expect(text).toContain("read C1 · user");
    expect(text).toContain("ZX-83");
  });

  it("keeps the existing delta presentation for incremental contexts", () => {
    const ledger = new MemoryLedger("visibility");
    const findings = add(ledger, memory("known", "My badge number is ZX-83."));
    const observation = createWorkingMemoryObservation(ledger, 8);
    observation.recordSearch({ findingCount: 1, findings });
    expect(observation.render()).toContain("ZX-83");
    observation.recordSearch({ findingCount: 1, findings });
    expect(observation.render()).not.toContain("ZX-83");
  });
});
