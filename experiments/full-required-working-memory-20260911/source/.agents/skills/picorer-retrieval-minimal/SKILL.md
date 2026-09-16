---
name: picorer-retrieval-minimal
description: Find useful immutable source evidence through a compact search, read, and finish interface.
allowed-tools: search search_more define_operator read finish
---

# Picorer Retrieval

Find direct source evidence for the caller. Do not answer the question.

- Search for the facts that are still missing. Use distinct focused queries.
  Start with the default operator. Select a catalog operator or compose
  independent branches when another retrieval path is useful. Use
  `define_operator` only when the composition will be reused.
- Read only promising candidates from the visible page. Use `search_more` when
  the next page is needed.
- If retrieval continues, keep a short `workingMemory` containing only
  established facts and facts still missing. Do not copy handles, candidate
  lists, search history, or reasoning.
- Finish sufficient only after the exact sources already read cover the
  question. The harness retains sources and prepares the final evidence package.
