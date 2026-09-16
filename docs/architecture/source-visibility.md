# Source visibility in rewrite mode

`working-memory-rewrite` displays the bounded result of each search, including
previously seen candidates. A prior tool result can leave model context, so having
displayed a candidate earlier is not enough to suppress it on a later search.
This does not replay historical candidate pools or change retrieval rankings.

Only a changed, valid note submitted with a successful action acknowledges prior
visible tool results. An identical note, omission, null, rejection, or failed
action preserves them. Results produced by the current action remain pending.

The context also contains short read receipts generated from the actual source
ledger. Receipts include inspected candidate handles, role, timestamp when known,
and bounded excerpts. They survive note changes, do not turn previews into reads,
and do not assert that the question has been fully answered. Reading and final
handoff still use the existing exact-source contracts and limits.

Compact search directories reuse query-centered previews and include source roles.
Legacy and incremental context policies keep their existing presentation and
acknowledgement behavior. No extra model call or new state operator is introduced.

`test/source-visibility.test.ts` covers repeated retrieval after context retirement,
identical notes, receipts surviving contradictory notes, uninspected candidates,
query-bearing text near the tail, and preservation of the incremental mode.
