import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createEphemeralMemoryContext } from "../src/evidence-agent/index.js";

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

describe("ephemeral memory context", () => {
  it("keeps every result in the current tool batch once", async () => {
    const context = createEphemeralMemoryContext();
    const oldSearch = toolResult("search-1", "search", "large noisy preview");
    const selectedInspect = toolResult("read-1", "read", "selected exact evidence");
    const currentSearch = toolResult("search-2", "search", "current preview");
    const messages = [
      oldSearch,
      {
        role: "user",
        content: "continue",
        timestamp: 2,
      } satisfies AgentMessage,
      selectedInspect,
      currentSearch,
    ];

    const transformed = await context.transformContext(messages);

    expect(transformed[0]).not.toBe(oldSearch);
    expect(JSON.stringify(transformed[0])).toMatch(/search payload expired/u);
    expect(transformed[2]).toBe(selectedInspect);
    expect(transformed[3]).toBe(currentSearch);
    expect(JSON.stringify(oldSearch)).toContain("large noisy preview");
    expect(context.snapshot()).toEqual({
      expiredNavigationResults: 1,
      compactedReadResults: 0,
    });
  });

  it("expires bash and operator-definition navigation but preserves errors", async () => {
    const context = createEphemeralMemoryContext();
    const bash = toolResult("bash-1", "bash_ro", "many grep rows");
    const definition = toolResult(
      "define-1",
      "define_operator",
      "defined dual-recall",
    );
    const error = {
      ...toolResult("search-error", "search", "failure"),
      isError: true,
    };
    const messages = [
      bash,
      definition,
      error,
      { role: "user", content: "continue", timestamp: 2 } satisfies AgentMessage,
    ];

    const transformed = await context.transformContext(messages);

    expect(JSON.stringify(transformed[0])).toMatch(/expired from active/u);
    expect(JSON.stringify(transformed[1])).toMatch(/expired from active/u);
    expect(transformed[2]).toBe(error);
    expect(context.snapshot()).toEqual({
      expiredNavigationResults: 2,
      compactedReadResults: 0,
    });
  });

  it("compacts an inspect after the model-facing turn has advanced", async () => {
    const context = createEphemeralMemoryContext();
    const oldInspect = toolResult("read-1", "read", "bounded exact evidence");
    const messages = [
      oldInspect,
      { role: "user", content: "continue", timestamp: 2 } satisfies AgentMessage,
    ];

    const transformed = await context.transformContext(messages);

    expect(transformed[0]).not.toBe(oldInspect);
    expect(JSON.stringify(transformed[0])).not.toContain("bounded exact evidence");
    expect(JSON.stringify(transformed[0])).toContain("final-source ledger");
    expect(context.snapshot()).toEqual({
      expiredNavigationResults: 0,
      compactedReadResults: 1,
    });
  });

  it("removes an old inspect payload after the turn while preserving its E receipt", async () => {
    const context = createEphemeralMemoryContext();
    const oldInspect = toolResult("read-1", "read", "Philips LED bulb");
    const latestSearch = toolResult(
      "search-2",
      "search",
      "<MEMORY>\nInspected evidence ledger\n- evidence E1 · inspected from C1\n</MEMORY>",
    );
    const messages = [
      oldInspect,
      { role: "user", content: "continue", timestamp: 2 } satisfies AgentMessage,
      latestSearch,
    ];

    const transformed = await context.transformContext(messages);

    expect(JSON.stringify(transformed[0])).not.toContain("Philips LED bulb");
    expect(JSON.stringify(transformed[2])).toContain("evidence E1");
    expect(context.snapshot()).toEqual({
      expiredNavigationResults: 0,
      compactedReadResults: 1,
    });
  });
});
