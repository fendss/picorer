# Changelog

## Unreleased

## 1.0.0 - 2026-09-11

- Preserve the full composable search-operator interface while allowing the
  compact evidence view and retrieval skill to evolve independently.
- Simplify optional working-memory progress and move history retirement into
  the harness without adding a separate state-model call.
- Keep stable candidate references, exact source coordinates, readable
  passages, and immutable parent evidence through read and answer handoff.
- Complete nearby sentence boundaries around source-matched legacy previews so
  read evidence does not end in the middle of a matched fact.
- Keep retrieval adequacy model-owned and strengthen CA trust, request
  timeouts, answer context fitting, concurrency control, and resumable evals.
- Keep source-role filtering in the harness-owned retrieval layer and remove it
  from Agent-authored search requests and run-local operator definitions.

## 1.4.0 - 2026-09-09

- Add lightweight, optional working-memory progress notes and simplify finish
  correction handling without adding a separate model call.
- Preserve repeated-search sources and actual read receipts through retrieval,
  context compaction, and the evidence-aware answer handoff.
- Split search composition into smaller planning, discovery, execution, and
  candidate-set modules while retaining the public search/read/finish protocol.
- Strengthen temporal, numeric, provenance, transport, concurrency, and Qdrant
  failure handling with regression coverage.
- Register the official large Fact-SH 262K and EventQA Full MemoryAgentBench
  tasks alongside Fact-MH 262K so the 1,600-query AMB-10 suite runs directly.

## 1.3.1

- Classify dense-retrieval failures so exact SQLite fallback is used only for
  Qdrant availability failures; configuration and provenance errors now remain
  visible and fail closed.
- Record fallback usage and every result-affecting HNSW setting in retrieval
  metadata and formal runtime identities.
- Pin all Qdrant settings in protected MemoryAgentBench YAML instead of
  inheriting ambient process values.
- Move SQLite lexical query planning and ranking out of the platform store,
  require dense retrievers to be injected into hybrid policy, and strengthen
  architecture tests around policy-to-adapter dependencies.

## 1.3.0

- Added the `picorer-hybrid-qdrant-hnsw-v1` retrieval profile behind the existing
  dense-retriever port. Qdrant provides the scalable dense lane, SQLite FTS5
  remains the lexical lane, and exact SQLite dense search is the failure
  fallback rather than a duplicate RRF vote.
- Added resumable, fingerprinted vector generations with a durable SQLite
  outbox, bounded concurrent Qdrant synchronization, index/count verification,
  and fail-closed scope coverage checks.
- Revalidate every Qdrant result against immutable SQLite scope, content hash,
  session, role, timestamp, and deterministic point identity before it enters
  the Candidate pipeline.
- Versioned Qdrant payloads and point identities include the generation, so
  multiple immutable generations can coexist in one collection without
  overwriting each other.
- LDBD service composition can select the same Qdrant profile; sealed online
  scopes derive corpus-fingerprinted generations while the Agent tool protocol
  remains unchanged.
- MemoryAgentBench YAML runs can pin the Qdrant profile, endpoint, collection,
  and vector generation in the same protected configuration. The resulting
  memory-index contract is included in the reproducible runtime identity.

## 1.2.0

- Organized the runtime as explicit `memory`, `retrieval`, `evidence-agent`,
  `agent-runtime`, and `benchmark` bounded contexts.
- Moved Pi-specific answer execution behind the benchmark adapter boundary and
  kept benchmark prompts and results in the domain model.
- Consolidated private JSONL persistence into one filesystem adapter with
  question- and scope-specific identities at the CLI boundary.
- Shortened core filenames and removed obsolete compatibility aliases without
  changing the public `search` → `read` → `finish` protocol.
- Removed one-off local ablation scripts and internal research notes from the
  release source tree; they remain available in repository history.
- Added MemoryAgentBench integration tests to the standard release check.

## 1.1.0

- Added extensible retrieval operators, exact evidence retention, benchmark
  integrations, and reproducible runtime identities.
