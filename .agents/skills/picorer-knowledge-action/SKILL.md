---
name: picorer-knowledge-action
description: Compose primitive retrievers into evidence plans while solving a knowledge-grounded interactive task, then act only from verified source documents and tool observations.
compatibility: Loaded directly by the Picorer interactive agent runtime; requires search, search_more, define_operator, and read, with optional bash_ro and caller-provided action tools.
allowed-tools: search search_more define_operator read bash_ro
---

# Picorer Knowledge-to-Action Planning

The initial catalog contains primitive retrievers. Use one primitive for a
simple evidence need. Compose a run-local plan when policy or procedure recall
requires multiple retrieval channels, ordering, or candidate-set
fusion. Do not assume a primitive exists unless it appears in the catalog.

## Routing loop

1. Separate the current user request into policy, eligibility, procedure,
   product, tool-discovery, and state-information needs.
2. Select primitive candidate generators from their capability metadata. Use
   lexical retrieval for exact policy terms and hybrid retrieval for uncertain
   wording. When more than one channel or transformation is needed, compose an
   ordered plan with search, `rrf`/`union`/`intersection`, sorting, session
   diversification, content deduplication, and limiting. Source roles are
   harness-owned metadata and are not plan inputs.
   Every plan input references an earlier step. Do not build a plan for an
   ordinary one-source search.
3. Treat search output as navigation. Explicitly `read` the strongest source
   documents before relying on their policy, parameter, limit, ordering rule,
   or tool signature. Oversized documents are returned as exact focused
   excerpts; read again when another passage or exact wording is needed.
4. Combine inspected documents with user statements and domain-tool observations.
   Ask the user for missing information instead of inventing it.
5. If coverage is incomplete and the latest search has another ranked page,
   use `search_more` before reformulating. Otherwise deliberately reformulate,
   split the missing need, or change one plan stage. Do not repeat an equivalent
   plan-query pair without new information.
6. Invoke domain action tools only after verifying the governing rules. Never
   combine memory operations and domain action calls in the same tool batch.

## Safety and grounding

- Preserve exact tool names, argument names, account/product names, limits,
  exceptions, and required action order from the source.
- A search miss is not evidence that a rule or capability does not exist.
- Never expose internal memory IDs or use evaluator labels, hidden task state,
  or benchmark-specific answer keys.
- Finish the user-facing task through the caller-provided domain tools or a
  concise response; there is no separate evidence-submission action.
