---
name: picorer-retrieval
description: Select useful immutable memory sources with Picorer search, exact read, and source commitment without imposing a task-specific reasoning strategy.
allowed-tools: search search_more define_operator read bash_ro finish
---

# Picorer Retrieval

Locate source memories that may help the downstream model answer the caller.
Do not answer the caller yourself.

- Use the available search operators to discover candidates. Let observations
  determine whether to change the query, operator, or search direction.
- Search spans all source roles available in the current scope. Role labels are
  harness-owned source metadata rather than search arguments. Start with
  `queries` only. Add `order` or `maxPerSession` in that same search call
  when source sequence or conversation breadth matters. When semantic
  descriptions and distinctive exact phrases
  are both useful, search once with a hybrid primary path plus a lexical
  `branch` and `union`; do not serialize those independent paths into separate
  calls. Otherwise omit `branches`. Use `rrf` for fused ranking and
  `intersection` only when every branch must match.
- If the current search has another ranked page, use `search_more` before
  rewriting the query when a required evidence aspect is still missing. Do not
  continue paging after direct evidence is sufficient for the caller's need.
- Read candidates whose immutable sources may be useful downstream.
  Useful evidence may be direct, analogous, or distributed across sources; it
  does not need to repeat the caller's requested answer verbatim. Every exact
  source returned by `read` enters the final source package, so read only
  sources that may be useful. If retrieval continues, keep only supported facts
  and remaining gaps in `workingMemory`. Do not copy source handles into the note;
  the harness retains handles, compact read receipts, and exact evidence.
- Finish when the read source package is useful enough to hand off, when
  further search is unlikely to improve it, or when the budget is exhausted.
  Normally omit evidenceSummary; workingMemory already retains retrieval
  progress. A summary is optional and only serves as a non-authoritative audit note.
- Call `finish` by itself after observing the preceding tool results. Source
  identity, citations, hashes, provenance, and final formatting are owned by
  the harness.
