import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";
import { createWorkingMemoryContext } from "../src/evidence-agent/adapters/pi/working-memory-context.js";
import { runPicorer, type PicorerRuntimeStore } from "../src/evidence-agent/adapters/pi/run-agent.js";
import { createSearchOperatorRegistry } from "../src/composition/create-search-operator-registry.js";
import { sha256 } from "../src/util.js";
import type { MemoryRecord } from "../src/memory/index.js";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";

const usage: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const action = (id: string, name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
  api: "openai-completions", provider: "mock", model: "mock", responseModel: "mock",
  usage, stopReason: "toolUse", timestamp: 1,
});
const result = (id: string, text: string, name = "read"): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: name,
  content: [{ type: "text", text }], isError: false, timestamp: 1,
});
const question: AgentMessage = { role: "user", content: "Original question", timestamp: 1 };
const stub: AgentTool = { name: "read", label: "Read", description: "Read",
  parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };

describe("working-memory context policy", () => {
  it("keeps observations through invalid updates and retires them only after an explicit valid decision", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"));
    const tool = context.wrapTools([stub])[0]!;
    const messages = [question, action("r1", "read", {}), result("r1", "exact old source")];
    expect(JSON.stringify(await context.transformContext(messages))).toContain("exact old source");
    await expect(tool.execute("next", {})).rejects.toThrow("workingMemory");
    await expect(tool.execute("next", { workingMemory: null })).rejects.toThrow("initial");
    await expect(tool.execute("next", { workingMemory: [{ op: "add", text: "Based on E999" }] })).rejects.toThrow("Unknown");
    expect(JSON.stringify(await context.transformContext(messages))).toContain("exact old source");
    await tool.execute("next", { workingMemory: [{ op: "add", text: "A fact is available; its missing relation still needs checking." }] });
    const output = await context.transformContext([...messages, action("r2", "read", {}), result("r2", "new source")]);
    expect(JSON.stringify(output)).not.toContain("exact old source");
    expect(JSON.stringify(output)).toContain("missing relation");
    expect(JSON.stringify(output)).toContain("new source");
    expect(JSON.stringify(messages)).toContain("exact old source");
  });

  it("never acknowledges unseen results produced in the same tool batch", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"));
    const tool = context.wrapTools([stub])[0]!;
    await context.transformContext([question]);
    await tool.execute("r1", { workingMemory: null });
    await tool.execute("r2", { workingMemory: null });
    const assistant = action("r1", "read", {});
    assistant.content.push({ type: "toolCall", id: "r2", name: "read", arguments: {} });
    const output = await context.transformContext([question, assistant, result("r1", "first"), result("r2", "second")]);
    expect(output.filter((m) => m.role === "toolResult")).toHaveLength(2);
    expect(output.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("requires acknowledgement on finish and strips the note before native tool execution", async () => {
    const nativeArgs: unknown[] = [];
    const context = createWorkingMemoryContext(new MemoryLedger("s"));
    const tool = context.wrapTools([{ ...stub, name: "finish", execute: async (_id, params) => {
      nativeArgs.push(params); return { content: [], details: { kind: "finish" } };
    } }])[0]!;
    await context.transformContext([question, action("s1", "search", {}), result("s1", "no useful matches", "search")]);
    const done = await tool.execute("f", { status: "insufficient", workingMemory: [{ op: "add", text: "No useful source was found; the requested fact remains missing." }] });
    expect(nativeArgs).toEqual([{ status: "insufficient" }]);
    expect(done.details.workingMemoryUpdate.acknowledgedToolCallIds).toEqual(["s1"]);
    expect(JSON.stringify(tool.parameters)).toContain('"workingMemory"');
  });

  it("retains an acknowledged note after a later read fails, while exposing the error", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"));
    const tool = context.wrapTools([{ ...stub, execute: async () => { throw new Error("source unavailable"); } }])[0]!;
    const previous = [question, action("s", "search", {}), result("s", "preview", "search")];
    await context.transformContext(previous);
    await expect(tool.execute("r", { workingMemory: [{ op: "add", text: "The source must be reopened before confirming it." }] })).rejects.toThrow("source unavailable");
    const error = { ...result("r", "source unavailable"), isError: true } as AgentMessage;
    const output = JSON.stringify(await context.transformContext([...previous, action("r", "read", {}), error]));
    expect(output).toContain("reopened");
    expect(output).toContain("source unavailable");
    expect(output).not.toContain('"preview"');
    expect(context.workingMemorySnapshot().history).toMatchObject([
      { toolCallId: "r", changes: [{ op: "add", id: "W1", after: "The source must be reopened before confirming it." }] },
    ]);
  });

  it("keeps pending evidence and the previous entries when an incremental patch exceeds the budget", async () => {
    const context = createWorkingMemoryContext(new MemoryLedger("s"));
    const tool = context.wrapTools([stub])[0]!;
    await tool.execute("initial", { workingMemory: [{ op: "add", text: "x".repeat(1600) }] });
    const messages = [question, action("r1", "read", {}), result("r1", "new evidence not yet saved")];
    await context.transformContext(messages);
    await expect(tool.execute("overflow", { workingMemory: [{ op: "add", text: "new finding" }] })).rejects.toThrow("Nothing was changed");
    expect(JSON.stringify(await context.transformContext(messages))).toContain("new evidence not yet saved");
    expect(context.workingMemorySnapshot().revision).toBe(1);
    const snapshot = context.workingMemorySnapshot();
    if (snapshot.version !== 2) throw new Error("Expected incremental snapshot");
    expect(snapshot.entries).toHaveLength(1);
  });

  it("suppresses repeated displayed text but exposes new text from the same candidate", () => {
    const ledger = new MemoryLedger("s");
    const memory: MemoryRecord = { memoryId: "m", scopeId: "s", sessionId: "one", turnIndex: 0,
      role: "user", content: "Both original facts", contentHash: sha256("Both original facts"), metadata: {} };
    ledger.recordSearchHits([{ record: memory, query: "first", retriever: "fts5", rank: 1, score: 1, preview: "first relation" }]);
    const context = createWorkingMemoryContext(ledger, 8);
    const display = (preview: string) => {
      context.observation.recordSearch({ findingCount: 1, findings: [{ ...ledger.candidates[0]!, preview }] });
      return context.observation.render();
    };
    expect(display("first relation")).toContain("first relation");
    expect(display("first relation")).not.toContain("first relation");
    expect(display("second relation in the same parent")).toContain("second relation");
    expect(context.observation.render()).not.toContain("second relation");
    expect(ledger.resolveCandidates(["C1"])[0]!.memoryId).toBe("m");
  });

  it("performs search, read, repeated search, reread and finish without separate state calls or evidence loss", async () => {
    const memory: MemoryRecord = { memoryId: "m", scopeId: "s", sessionId: "one", turnIndex: 0,
      role: "user", content: "The required fact is blue.", contentHash: sha256("The required fact is blue."), metadata: {} };
    const store: PicorerRuntimeStore = {
      search: () => [{ record: memory, query: "fact", retriever: "fts5", rank: 1, score: 1, preview: memory.content }],
      read: () => [memory], findMentionedMemoryIds: () => [], getRecords: () => [memory],
    };
    const script = [
      action("s1", "search", { queries: ["fact"], workingMemory: null }),
      action("r1", "read", { candidateRefs: ["C1"], workingMemory: [{ op: "add", text: "C1 may provide the fact; need its original wording." }] }),
      action("s2", "search", { queries: ["fact"], workingMemory: [{ op: "update", id: "W1", text: "E1 from C1 states blue." }, { op: "add", text: "Check whether another source changes it." }] }),
      action("r2", "read", { candidateRefs: ["C1"], workingMemory: null }),
      action("f", "finish", { status: "sufficient", workingMemory: [{ op: "retire", id: "W2", reason: "The follow-up read is complete." }] }),
    ];
    const inputs: string[] = [];
    let index = 0;
    const runtime: PiModelRuntime = {
      modelAdapterId: "test", providerId: "mock", modelId: "mock", thinkingLevel: "off", transport: "sse",
      model: { id: "mock", name: "mock", api: "openai-completions", provider: "mock", baseUrl: "http://localhost:1",
        reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      getApiKey: async () => "test",
      streamFn: (_model, context) => {
        inputs.push(JSON.stringify(context.messages));
        const message = script[index++];
        if (!message) throw new Error("Unexpected extra model call");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "toolUse", message }); });
        return stream;
      },
    };
    const output = await runPicorer({ store, operatorRegistry: createSearchOperatorRegistry(store), modelRuntime: runtime,
      scopeId: "s", question: "What is the fact?", maxSearchCalls: 8, contextPolicy: "working-memory-v2" });
    expect(inputs).toHaveLength(5);
    expect(output.trace.every((t) => !t.isError)).toBe(true);
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]!.content).toBe(memory.content);
    expect(inputs[2]).toContain("The required fact is blue.");
    expect(inputs[3]).not.toContain("The required fact is blue.");
    expect(inputs[3]).toContain("E1 from C1 states blue");
    expect(inputs[4]).toContain("The required fact is blue.");
    if (output.workingMemory?.version !== 2) throw new Error("Expected incremental snapshot");
    expect(output.workingMemory.entries).toEqual([{ id: "W1", text: "E1 from C1 states blue." }]);
    expect(output.workingMemory?.history).toHaveLength(3);
    expect(output.workingMemory?.history[2]!.changes[0]).toMatchObject({
      op: "retire", id: "W2", before: "Check whether another source changes it.",
    });
    await expect(runPicorer({ store, operatorRegistry: createSearchOperatorRegistry(store), modelRuntime: runtime,
      scopeId: "s", question: "fact", contextPolicy: "working-memory-v1" as never })).rejects.toThrow("Unsupported contextPolicy");
    expect(inputs).toHaveLength(5);
  });
  it("v3 omission keeps observations pending until an explicit acknowledgement", async () => {
    const context=createWorkingMemoryContext(new MemoryLedger("s"),8,"progress");
    const read=context.wrapTools([stub])[0]!;
    const prior=[question,action("s1","search",{}),result("s1","earlier source","search")];
    await context.transformContext(prior);
    await read.execute("r1",{});
    expect(JSON.stringify(await context.transformContext(prior))).toContain("earlier source");
    await read.execute("r2",{workingMemory:null});
    expect(JSON.stringify(await context.transformContext(prior))).not.toContain("earlier source");
  });
  it.each(["working-memory-v3", "working-memory-rewrite"] as const)("runs %s through the actual Agent protocol and keeps the tool contract stable across nudges", async (policy) => {
    const memory: MemoryRecord = { memoryId: "m", scopeId: "s", sessionId: "one", turnIndex: 0,
      role: "user", content: "The required fact is blue.", contentHash: sha256("The required fact is blue."), metadata: {} };
    const store: PicorerRuntimeStore = {
      search: () => [{ record: memory, query: "fact", retriever: "fts5", rank: 1, score: 1, preview: memory.content }],
      read: () => [memory], findMentionedMemoryIds: () => [], getRecords: () => [memory],
    };
    const script = [
      action("s1", "search", { queries: ["fact"], workingMemory: null }),
      action("r1", "read", { candidateRefs: ["C1"], workingMemory: policy === "working-memory-rewrite" ? "C1 supports blue. Need to check a remaining relation." : [{ op: "add", question: "Required fact?", choice: "blue", sources: [{ref: "C1", quote: "The required fact is blue."}], gap: "", dependsOn: [] }] }),
      { ...action("stop", "finish", {}), content: [{type:"text",text:"Done searching."}], stopReason:"stop" } as AssistantMessage,
      action("f", "finish", { status: "sufficient" }),
    ];
    const inputs: string[] = [];
    let index = 0;
    const runtime: PiModelRuntime = {
      modelAdapterId: "test", providerId: "mock", modelId: "mock", thinkingLevel: "off", transport: "sse",
      model: { id: "mock", name: "mock", api: "openai-completions", provider: "mock", baseUrl: "http://localhost:1",
        reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      getApiKey: async () => "test",
      streamFn: (_model, context) => {
        inputs.push(JSON.stringify(context));
        const message = script[index++];
        if (!message) throw new Error("Unexpected extra model call");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "toolUse", message }); });
        return stream;
      },
    };
    const output = await runPicorer({ store, operatorRegistry: createSearchOperatorRegistry(store), modelRuntime: runtime,
      scopeId: "s", question: "What is the fact?", maxSearchCalls: 1, contextPolicy: policy });
    expect(inputs).toHaveLength(4);
    expect(output.status).toBe("sufficient");
    expect(output.trace.map(t=>t.toolName)).toEqual(["search","read","finish"]);
    expect(output.workingMemory?.version).toBe(policy === "working-memory-rewrite" ? 1 : 3);
    expect(output.evidence[0]!.content).toContain("The required fact is blue.");
    for (const payload of inputs.slice(1).map(s=>JSON.parse(s))) {
      expect(payload.tools.map((t: {name:string})=>t.name)).toContain("search");
      expect(payload.tools.map((t: {name:string})=>t.name)).toContain("read");
    }
    if (policy === "working-memory-v3") expect(inputs[2]).toContain('\\"read\\":true');
  });
});
