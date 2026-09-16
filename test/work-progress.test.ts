import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { WorkProgress } from "../src/evidence-agent/model/work-progress.js";
import { MemoryLedger } from "../src/evidence-agent/model/ledger.js";
import { createWorkingMemoryContext } from "../src/evidence-agent/adapters/pi/working-memory-context.js";
import { createWorkProgress } from "../src/evidence-agent/adapters/pi/work-progress-contract.js";
import { projectMemoryEvidence } from "../src/evidence-agent/model/source-evidence.js";
import { sha256 } from "../src/util.js";

const add = (question: string, choice = "Paris", dependsOn: {id: string; version: number}[] = []) =>
  ({ op: "add", question, choice, sources: [{ref: "C1", quote: "Lives in Paris."}], gap: "", dependsOn });
const memory = () => new WorkProgress({ validate() {}, delivered: () => true, identity: s => JSON.stringify([s.ref,s.quote]) });

describe("current task progress", () => {
  it("invalidates only dependent branches transitively and never revives old choices", () => {
    const m = memory();
    m.apply([add("Residence?"), add("Profession?", "Singer")], "1");
    m.apply([add("Country?", "France", [{id:"W1", version:1}])], "2");
    m.apply([add("Continent?", "Europe", [{id:"W3", version:1}])], "3");
    m.apply([{op:"update",id:"W1",choice:"Berlin",sources:[{ref:"C1",quote:"Lives in Berlin."}]}], "4");
    expect(m.snapshot().entries.map(e => [e.id,e.stale])).toEqual([["W1",false],["W2",false],["W3",true],["W4",true]]);
    expect(m.gaps().join(" ")).toContain("W3: upstream");
    expect(() => m.apply([{op:"update",id:"W3",gap:""}], "5")).toThrow("Recheck");
    m.apply([{op:"update",id:"W1",choice:"Paris",sources:[{ref:"C1",quote:"Lives in Paris."}]}], "6");
    expect(m.snapshot().entries[2]!.stale).toBe(true);
    m.apply([{op:"update",id:"W3",choice:"France",sources:[{ref:"C1",quote:"Paris is in France."}],dependsOn:[{id:"W1",version:3}]}], "7");
    expect(m.snapshot().entries[2]!.stale).toBe(false);
    expect(m.snapshot().entries[3]!.stale).toBe(true);
    expect(m.snapshot().history[3]!.changes.filter(e=>e.op==="invalidate")).toHaveLength(2);
  });
  it("makes repeated identical adds idempotent without consuming IDs or changing history", () => {
    const m=memory();m.apply([add("Residence?")],"1");
    const reordered = { ...add("Residence?"), sources: [{quote:"Lives in Paris.",ref:"C1"}] };
    expect(m.apply([reordered],"2").changes).toEqual([]);
    expect(m.snapshot().revision).toBe(1);
    m.apply([add("Profession?","Singer")],"3");
    expect(m.snapshot().entries.map(e=>e.id)).toEqual(["W1","W2"]);
  });
  it("keeps unrelated answer items and old audit versions while replacing only the current gap", () => {
    const m=memory(); m.apply([add("Spouse?"), {...add("Job?"),gap:"Check conflicting version"}],"1");
    m.apply([{op:"update",id:"W2",gap:""}],"2");
    expect(m.snapshot().entries[0]).toEqual(m.snapshot().history[0]!.changes[0]!.after);
    expect(m.snapshot().history[0]!.changes[1]!.after!.gap).toBe("Check conflicting version");
    expect(m.render()).not.toContain("Check conflicting version");
    expect(m.snapshot().entries[1]!.version).toBe(1);
  });
  it("rejects cyclic, stale and partial choice updates atomically", () => {
    const m=memory();m.apply([add("First?")],"1");m.apply([add("Second?","France",[{id:"W1",version:1}])],"2");
    const before=m.snapshot();
    expect(()=>m.apply([{op:"update",id:"W1",dependsOn:[{id:"W2",version:1}]}],"3")).toThrow("cycle");
    expect(()=>m.apply([{op:"update",id:"W1",choice:"Berlin"}],"4")).toThrow("sources");
    expect(()=>m.apply([add("third?","x",[{id:"W1",version:8}])],"5")).toThrow("dependency");
    expect(m.snapshot()).toEqual(before);
  });
  it("rejects an overflow atomically but still permits read and insufficient finish with no patch", async () => {
    const c=createWorkingMemoryContext(new MemoryLedger("s"),8,"progress");
    let reads=0,finishes=0;
    const [read,finish]=c.wrapTools([
      {name:"read",label:"read",description:"read",parameters:Type.Object({}),execute:async()=>{reads++;return {content:[],details:{}};}},
      {name:"finish",label:"finish",description:"finish",parameters:Type.Object({status:Type.String()}),execute:async()=>{finishes++;return {content:[],details:{}};}},
    ]);
    await expect(read!.execute("bad",{workingMemory:[{...add("x".repeat(1599)),sources:[]}]})).rejects.toThrow("Nothing changed");
    expect(reads).toBe(0);
    await read!.execute("read",{});await finish!.execute("finish",{status:"insufficient"});
    expect([reads,finishes]).toEqual([1,1]);
    expect(c.workingMemorySnapshot().revision).toBe(0);
    expect((finish!.parameters as {required?: string[]}).required).not.toContain("workingMemory");
  });
  it("keeps the tool contract stable after the semantic budget is exhausted", () => {
    const c=createWorkingMemoryContext(new MemoryLedger("s"),1,"progress");
    const tools=["search","search_more","read","finish"].map(name=>({name,label:name,description:name,parameters:Type.Object({}),execute:async()=>({content:[],details:{}})}));
    expect(c.availableTools(tools)).toHaveLength(4);
    c.observation.recordSearch({queries:[],findings:[],directoryFindings:[]} as never);
    expect(c.availableTools(tools).map(t=>t.name)).toEqual(["search","search_more","read","finish"]);
  });
  it("keeps dependent judgments valid when C becomes E for the same supporting source", () => {
    const ledger=new MemoryLedger("s"),content="Lives in Paris. Paris is in France.";
    const record={memoryId:"m",scopeId:"s",sessionId:"x",turnIndex:0,role:"user" as const,content,contentHash:sha256(content),metadata:{}};
    ledger.recordSearchHits([{record,query:"residence",preview:content,rank:1,score:1,retriever:"fts5"}]);
    const {memory:m,recordShown}=createWorkProgress(ledger);recordShown("C1",content);
    m.apply([add("Residence?")],"1");
    m.apply([{...add("Country?","France",[{id:"W1",version:1}]),sources:[{ref:"C1",quote:"Paris is in France."}]}],"2");
    ledger.recordInspect([projectMemoryEvidence(record,[],8192)]);
    m.apply([{op:"update",id:"W1",sources:[{ref:"E1",quote:"Lives  in Paris."}]}],"3");
    expect(m.snapshot().entries[0]!.version).toBe(1);
    expect(m.snapshot().entries[1]!.stale).toBe(false);
    expect(m.snapshot().history.flatMap(h=>h.changes).some(c=>c.op==="invalidate")).toBe(false);
    expect(()=>m.assertFinish("sufficient")).not.toThrow();
    expect(m.apply([{...add("Residence?"),sources:[{quote:"Lives in Paris.",ref:"E1"}]}],"4").changes).toEqual([]);
    expect(m.snapshot().entries).toHaveLength(2);
  });
  it("checks a required exact quote rather than trusting a read of its parent", () => {
    const ledger=new MemoryLedger("s");
    const content="Lives in Paris. Works as singer.";
    const record={memoryId:"m",scopeId:"s",sessionId:"x",turnIndex:0,role:"user" as const,content,contentHash:sha256(content),metadata:{}};
    ledger.recordSearchHits([{record,query:"residence",preview:"Lives in Paris.",score:1,rank:1,retriever:"fts5"}]);
    const {memory:m,recordShown}=createWorkProgress(ledger);
    recordShown("C1","Lives in Paris.");m.apply([add("Residence?")],"1");
    expect(()=>m.assertFinish("sufficient")).toThrow("read C1");
    const evidence=projectMemoryEvidence(record, [], 8192);
    ledger.recordInspect([{...evidence,content:"Works as singer.",contentHash:sha256("Works as singer."),truncated:true,excerpts:[{start:16,end:32,content:"Works as singer."}]}]);
    expect(()=>m.assertFinish("sufficient")).toThrow("read C1");
    expect(()=>m.apply([{op:"update",id:"W1",sources:[{ref:"C1",quote:"Lives in Rome."}]}],"2")).toThrow("not in");
    ledger.recordInspect([evidence]);
    expect(()=>m.assertFinish("sufficient")).not.toThrow();
  });
});
