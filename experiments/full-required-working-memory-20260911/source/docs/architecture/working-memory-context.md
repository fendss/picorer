# Working-memory context policies

## Single-note rewrite (opt-in)

`runPicorer({ contextPolicy: "working-memory-rewrite", ... })` uses one optional
free-text progress note. A nonempty string replaces the note; omission and null
keep it unchanged. The note contains only plain-text `Established` facts and
`Missing` facts. It does not carry candidate handles, evidence handles, source
IDs, candidate lists, search history or a reasoning transcript.

Source identity and context lifecycle belong to the harness. Search results are
navigation for the next decision, so a promising candidate should be read before
the Agent moves to another search. The harness validates the candidate handle in
the actual `read` argument, records the exact returned source in the evidence
ledger, and renders compact receipts from that ledger independently of the note.
A model-authored note cannot create, select or remove source evidence.

Every successful tool action retires raw tool results that were visible in its
preceding model input. The result produced by the current action remains visible
for the next decision. A failed action retires nothing, allowing the Agent to
correct the call. Context retirement does not depend on whether the optional note
was changed, omitted, repeated or rejected.

The note budget is 1600 characters. A blank or oversized replacement is rejected
without blocking an otherwise valid tool action; the previous note remains. The
harness reports this separately in `workingMemoryUpdate`. Old note revisions and
full tool payloads remain in the audit rather than active model context. There is
no separate state model call.

`finish` normally needs only `status`. A sufficient finish requires at least one
exact source read and commits every source in the read ledger. `evidenceSummary`
is an optional audit string. The note itself never enters the answer package.
The default context policy remains `current-window`.

## Incremental entries (experimental)

`runPicorer({ contextPolicy: "working-memory-v2", ... })` enables an incremental
notebook. The default remains `current-window`. The old `working-memory-v1`
whole-note replacement experiment remains reproducible from its frozen source;
its option is rejected in the live implementation instead of silently changing
meaning or falling back to the default.

## Update contract

Every existing tool, including finish, accepts a required `workingMemory` field.
Use `null` or `[]` when no entry needs changing. Otherwise send only local edits:

```json
{
  "workingMemory": [
    {"op": "add", "text": "C5 establishes the broadcaster as NBC; still need its founding city."}
  ]
}
```

The program assigns stable IDs such as W1, visible in the next model input. A
later `add` creates W2 and leaves W1 intact. To change or retire a particular
entry, explicitly address its ID:

```json
{
  "workingMemory": [
    {"op": "update", "id": "W1", "text": "C5 establishes the broadcaster as NBC; its founding city is now supported by E1."},
    {"op": "retire", "id": "W2", "reason": "This search gap has been resolved."}
  ]
}
```

Omitted entries always survive. Keep a single judgment or unresolved need in an
entry; correcting an entry still replaces its own text. The program checks IDs
and source-reference existence, not semantic truth or whether an update omitted
part of a multi-fact entry. There is no automatic dependency inference or extra
model call.

A patch contains at most 16 operations. It is validated as a whole before any
mutation: a wrong reference, unknown entry, double edit of one ID, malformed
operation, or active-text overflow rejects the entire patch without consuming
IDs or changing the revision. IDs created in that patch cannot be guessed and
edited within the same patch. Retired IDs cannot be reused or implicitly revived.

The sum of active entry text remains bounded at 1600 characters, as in the
previous note budget; IDs and rendering markup are additional. Overflow never
truncates or evicts entries. It returns an explicit error; the model may submit
an intentional local edit or retirement. Historical values remain in the audit.

## Visibility and audit

The model receives the question, all active entries, and unacknowledged tool
results. After the first observed result it must add an initial entry. A valid
patch or unchanged decision acknowledges only results in the previous model
input, never unseen results produced by the current batch. Invalid patches keep
both the old notebook and the pending observations.

The patch is committed before the requested tool action. A subsequent read or
search failure does not undo it: updating knowledge already observed and trying
a new action are separate operations. Both successful runs and failure
diagnostics contain `workingMemory` with version, revision, active entries and
an append-only history keyed by tool-call ID. History stores the old and new text
for updates and the original text plus reason for retirement, including when the
subsequent tool action failed. Successful tool receipts also include the change
and acknowledgement IDs. Returned snapshots are detached copies.

History stays in the audit, rather than being repeatedly sent to the model. It
records changes to model-authored notes; it is neither hidden model reasoning nor
source evidence. The original tool transcript is also preserved.

Candidate presentation and source delivery are unchanged in this iteration.
Known C references remain readable, new or changed candidate text is displayed,
and read sources still form the final evidence package. A fact merely written in
a notebook does not automatically cause its source to be read or delivered.

## Validation and limits

Offline regression uses the Q3 failure pattern: add the first relationship,
then add the second without mentioning the first. Both entries remain visible.
Tests also cover independent updates, explicit retirement, audit retention,
atomic failure, overflow, ID stability, same-batch observations, native tool
failure, and the real Agent tool integration with a scripted model.

These tests verify the incremental contract, not accuracy improvement with Qwen.
The preceding 44-question experiment measured whole-note replacement, not this
version. Its results and frozen source are preserved and must not be relabeled
as an evaluation of incremental working memory.

## Version 3: current task progress (opt-in)

`contextPolicy: "working-memory-v3"` reuses the same context projection and
source ledger. It changes the notebook contract to small current subquestions.
The default and version 2 remain available with their existing behavior.
No standalone state tool, model call, retrieval algorithm or answer prompt is added.

A task has `question`, `choice`, `sources` (visible C or read E reference and
verbatim quote), `gap`, and `dependsOn` (prior W ID and version). The program
assigns the ID, version and stale flag. For example:

```json
{"workingMemory":[{"op":"add","question":"Residence?","choice":"Paris","sources":[{"ref":"C1","quote":"Lives in Paris."}],"gap":"","dependsOn":[]}]}
```

Update only changed fields of the existing W item. Missing fields and other
items survive. Changing a choice requires supplying its sources together;
`[]` explicitly records missing support. A gap-only edit does not change the
judgment version. Changing its question, choice, supporting sources or declared
dependencies increments the version and makes descendants of the old version
stale. Unrelated tasks survive. A stale task must explicitly resubmit its choice,
sources and current dependencies after rechecking. Returning an upstream choice
to an old value never revives an old descendant. Cycles and guessed future IDs
are rejected. Retiring a task preserves its audit and invalidates its dependents.

All current question, choice, quote and gap text shares the existing 1600
character budget. Structural fields and source handles are additional. At most
12 current tasks and 16 edits per transaction are accepted. There is no silent
truncation or automatic eviction. History stays outside the model context.

In v3, search requires a patch or explicit null; after the first observation an
initial task is required before another search. Read and finish accept omission,
which keeps observations pending. Null or an empty array explicitly acknowledges
visible observations without changing tasks. Equivalent repeated adds are idempotent
and do not allocate duplicate IDs. The program still cannot infer what omitted
progress should contain. An invalid
patch blocks the action and preserves observations; a valid patch is retained
if the native action subsequently fails. A rejected sufficient finish can also
leave a valid patch committed. Insufficient finish never requires a new note.

Sufficient finish checks **declared** tasks for gaps, missing choices, stale
judgments, missing sources and quote coverage in the exact read ledger. Reading
another passage from the same parent is insufficient. Quotes are matched within
individual excerpts, allowing whitespace differences, without semantic paraphrase
matching. These exact read sources are handed to the answer adapter as before.
A source ref is not proof that its text entails the model's judgment. Undeclared
question requirements and incorrectly cleared semantic gaps cannot be detected
by the program. Insufficient finish remains available without pretending success.

When the semantic search budget reaches zero, the next provider request omits
`search`; its native guard remains in place for actions already in the current
batch. `search_more` remains available because it only exposes buffered results.
The Agent runtime's documented next-turn context hook implements this without
modifying the dependency or adding a retry layer.

Implementation is split between `model/work-progress.ts` (transactions and
invalidation), `adapters/pi/work-progress-contract.ts` (tool schema, prompt and
source coverage), and the existing shared context adapter. Tests cover independent
answer items, dependency revisions and no resurrection, atomic rejection, missing
quote despite parent read, optional read and finish, and actual Agent tool
visibility. Real-model evidence is reported separately from these guarantees.

Final correctness repair: task identity compares parsed fields rather than JSON key order. Supporting source identity uses immutable parent identity and whitespace-normalized verbatim quote; changing only C to E does not change the judgment version or invalidate descendants. This repair was validated with reordered tool arguments and an actual ledger C-to-E transition, then separately frozen for a final 44-question run. Earlier model runs retain their original source and results.
