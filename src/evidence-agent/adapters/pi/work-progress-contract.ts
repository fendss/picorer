import { Type } from "@earendil-works/pi-ai";
import type { MemoryLedger } from "../../model/ledger.js";
import { WorkProgress, type WorkSource } from "../../model/work-progress.js";

const text = Type.String({ maxLength: 1600 });
const ref = Type.String({ pattern: "^[CE][1-9][0-9]*$" });
const id = Type.String({ pattern: "^W[1-9][0-9]*$" });
const fields = {
  question: Type.String({ minLength: 1, maxLength: 1600, description: "Short subquestion; one item per relation or answer item, never an activity log." }),
  choice: text,
  sources: Type.Array(Type.Object({ ref, quote: Type.String({ minLength: 1, maxLength: 1600, description: "Verbatim supporting relation from the cited visible source; whitespace may differ." }) }, { additionalProperties: false }), { maxItems: 12 }),
  gap: Type.String({ maxLength: 1600, description: "Remaining check or uncertainty; empty only when resolved. Keep useful unread C refs here." }),
  dependsOn: Type.Array(Type.Object({ id, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 12 }),
};
export const WorkProgressParameters = Type.Union([
  Type.Array(Type.Union([
    Type.Object({ op: Type.Literal("add"), ...fields }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("update"), id, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Type.Optional(v)])) }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("retire"), id, reason: Type.String({ minLength: 1, maxLength: 1600 }) }, { additionalProperties: false }),
  ]), { maxItems: 16 }), Type.Null(),
], { description: "Local task changes required on search, optional on read and finish. Omitted keeps observations pending; null explicitly acknowledges them. Both keep all tasks. Update the existing task when its choice or gap changes. IDs and versions are program assigned. Patch precedes tool execution; an invalid patch prevents the action." });

const normalized = (s: string) => s.replace(/\s+/gu, " ").trim();
const contains = (body: string, quote: string) => normalized(body).includes(normalized(quote));
export function createWorkProgress(ledger: MemoryLedger) {
  const shown = new Map<string, Set<string>>();
  const memoryId = (ref: string) => {
    if (/^C[1-9]\d*$/u.test(ref)) return ledger.resolveCandidates([ref])[0]!.memoryId;
    const evidence = ledger.inspectedEvidence.find(e => ledger.evidenceRef(e.memoryId) === ref);
    if (!evidence) throw Error(`Unknown source ref ${ref}`);
    return evidence.memoryId;
  };
  const delivered = (s: WorkSource) => ledger.inspectedEvidence.some(e =>
    e.memoryId === memoryId(s.ref) && e.excerpts.some(x => contains(x.content, s.quote)));
  const memory = new WorkProgress({ delivered,
    // C and E are presentation handles for the same immutable source. Changing
    // handles or whitespace does not change the supporting relation.
    identity: s => JSON.stringify([memoryId(s.ref), normalized(s.quote)]),
    validate(s) {
    memoryId(s.ref);
    if (!delivered(s) && ![...(shown.get(s.ref) ?? [])].some(body => contains(body, s.quote))) {
      throw Error(`Quote for ${s.ref} is not in its displayed or read text. Copy a visible relation exactly, or keep sources empty and leave a gap until read.`);
    }
  } });
  return { memory, recordShown(ref: string, body: string) {
    const texts = shown.get(ref) ?? new Set<string>(); texts.add(body); shown.set(ref, texts);
  } };
}

export const WORK_PROGRESS_PROMPT = `
Context policy: working-memory-v3 (current task progress).
Only the original question, current tasks and unacknowledged tool results remain.
Old candidate lists and reasoning are not replayed. Stored C refs remain readable.
Maintain one small task per subquestion or answer item, not the whole original
question in every item. gap concerns unresolved checks for THAT subquestion;
record a subsequent relation as its own task. Before moving to the next
relation, record the current choice, its verbatim supporting source and remaining
checks. Follow that selected entity, not an older alternative or world knowledge.
Use the conflict and time rules in the question. A plausible answer is not proof
that remaining checks are resolved. Do not invent extra version searches when
not required by the question or conflicting evidence.
On search, workingMemory is required: use null on the first search if needed.
After observing sources, save an initial task before another search. On read and
finish the field is optional. Omission retains pending observations; null or []
explicitly acknowledges them without edits. Add {op:"add",question,choice,sources,gap,
dependsOn}; the program returns W IDs and versions. Unknown choice is "", unknown
sources is [], remaining uncertainty belongs in gap. sources contains {ref,quote}
from a visible C or read E source. Keep quotes short but retain the full relation.
Update {op:"update",id,...changedFields} on that SAME task as progress changes.
These are operations INSIDE workingMemory, never separate tools named add or
update. Do not resend old adds; exact repeated adds are harmless acknowledgements.
For a dependent task use dependsOn:[{id:"W1",version:1}]. Upstream changes mark
old dependents stale; explicitly recheck choice, sources and dependsOn to reuse
them. Unrelated tasks stay intact. retire with id and reason removes an irrelevant
task from the current view but preserves its audit. Do not retire necessary hops
just to claim completion. No search diary, stale to-do lists or whole-note rewrite.
Current task text including quotes shares 1600 characters; audit is outside this
budget. Omitted fields and tasks are retained. Read or finish without a patch is
always possible; an invalid patch rejects the action atomically. A valid patch
stays committed even if the native action later fails.
The view reports whether each required quote is already in the exact read package.
Read the missing C refs before finishing sufficient. Cover EVERY relation and
answer item. A note or a parent-level read alone is not source coverage. Leave
unresolved gaps and finish insufficient if you cannot obtain complete evidence.
Finish needs no new summary or "done" note. The answer handoff uses the exact
read sources, not this fallible task table. No separate state model call exists.
`;
