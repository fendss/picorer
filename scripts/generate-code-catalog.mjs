import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const sourceRoot = resolve(projectRoot, "src");
const codeCatalogPath = resolve(projectRoot, "docs", "architecture", "code-catalog.md");
const fileCatalogPath = resolve(projectRoot, "docs", "architecture", "file-catalog.md");

const FILE_RESPONSIBILITIES = new Map(Object.entries({
  "src/evidence-agent/model/work-progress.ts": "Maintains small current task judgments, declared dependencies and exact-source obligations with atomic patches and a revision audit.",
  "src/evidence-agent/adapters/pi/work-progress-contract.ts": "Defines the opt-in task-progress tool contract and checks quoted source references against displayed and read evidence.",
  "src/evidence-agent/adapters/pi/working-memory-context.ts": "Applies opt-in replacement notes or incremental edits and retires only acknowledged tool results.",
  "src/evidence-agent/adapters/pi/rewrite-working-memory-context.ts": "Keeps optional progress notes separate from tool execution, preserves unacknowledged observations, and reports rejected note updates without blocking source reads.",
  "src/evidence-agent/model/rewrite-working-memory.ts": "Maintains one replaceable short note with reference validation and an audit outside model context.",
  "src/evidence-agent/model/working-memory.ts": "Stores stable notebook entries with atomic local edits, explicit retirement, and an append-only audit without silently truncating prior information.",
  "src/evidence-agent/adapters/pi/working-memory-observation.ts": "Presents bounded search candidates with opt-in current-result refresh while preserving stable reread references.",
  "src/evidence-agent/adapters/pi/read-receipts.ts": "Renders bounded receipts from the actual read ledger independently of model-authored progress notes.",
  "src/cli.ts": "Emits the stable build artifact that starts the Picorer CLI entrypoint.",
  "src/memoryarena-public-api.ts": "Emits the stable build artifact that starts the MemoryArena Public HTTP entrypoint.",
  "src/tau-knowledge-bridge.ts": "Emits the stable build artifact that starts the tau-Knowledge bridge entrypoint.",
  "src/agent-runtime/interactive-memory-agent.ts": "Runs a stateful Pi Agent loop that interleaves memory operations with caller-owned environment tools.",
  "src/benchmark/amabench/answer-contract.ts": "Builds AMA-Bench answer prompts exclusively from cited trajectory evidence.",
  "src/benchmark/amabench/dataset-adapter.ts": "Pins and adapts AMA-Bench trajectories while separating runner queries from judge labels.",
  "src/benchmark/amabench/evaluation-contract.ts": "Joins frozen AMA-Bench predictions to judge inputs and official episode submissions.",
  "src/benchmark/amabench/judge.ts": "Runs and aggregates the pinned AMA-Bench binary judge protocol with explicit fallback accounting.",
  "src/benchmark/adapters/pi/answer.ts": "Runs benchmark answer synthesis through the Pi model runtime adapter.",
  "src/benchmark/model/answer.ts": "Defines provider-neutral benchmark answer prompts, results, and execution policy.",
  "src/benchmark/data-paths.ts": "Defines the shared workspace paths for evidence-based benchmark adapters.",
  "src/benchmark/label-firewall.ts": "Rejects private evaluation labels at benchmark ingest boundaries before they reach core memory.",
  "src/benchmark/longmemeval/data-paths.ts": "Defines the filesystem paths used by a LongMemEval workspace.",
  "src/benchmark/longmemeval/dataset-adapter.ts": "Validates and adapts LongMemEval-S records into Picorer sessions and private questions.",
  "src/benchmark/memoryagentbench/answer-contract.ts": "Builds MemoryAgentBench answer prompts from the benchmark question and Picorer-retrieved memory context.",
  "src/benchmark/memoryagentbench/dataset.ts": "Validates MemoryAgentBench records and maps their contexts and questions into the Picorer benchmark boundary.",
  "src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts": "Persists each official MemoryArena user's active Picorer generation and crash-resumable append ordinal.",
  "src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts": "Durably records privacy-safe initialize, add, and wrap lifecycle events with retrieval and embedding usage deltas.",
  "src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts": "Writes serialized, permission-restricted MemoryArena wrap and retrieval audit records.",
  "src/benchmark/memoryarena-public/adapters/measured-embedder.ts": "Attributes every embedding provider attempt to its originating MemoryArena add or wrap operation without serializing concurrent requests.",
  "src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts": "Adapts alternating MemoryArena add and wrap operations to immutable Picorer chunks and evidence retrieval.",
  "src/benchmark/memoryarena-public/composition/create-runtime.ts": "Wires the MemoryArena HTTP memory boundary to one leased online Picorer runtime and durable audit state.",
  "src/benchmark/memoryarena-public/model/failure-diagnostics.ts": "Defines privacy-safe structured diagnostics for failed MemoryArena Picorer retrieval runs.",
  "src/benchmark/memoryarena-public/model/memory-backend.ts": "Defines the MemoryArena Public memory-backend state, wire-neutral results, audit records, and errors.",
  "src/benchmark/memoryarena-public/ports/memory-backend.ts": "Defines generation, source-chunk, retrieval, and audit capabilities required by the MemoryArena use case.",
  "src/benchmark/memoryarena-public/use-cases/memory-backend.ts": "Implements initialize, add, and evidence-only prompt wrapping without benchmark-specific infrastructure dependencies.",
  "src/benchmark/model/benchmark-query.ts": "Defines the benchmark question model shared at the benchmark boundary.",
  "src/benchmark/model/benchmark-run.ts": "Defines durable benchmark prediction, success, and failure artifact records.",
  "src/benchmark/model/evidence-benchmark-run.ts": "Defines text predictions plus durable evidence-benchmark run records.",
  "src/benchmark/tau-knowledge/data-paths.ts": "Defines the local workspace paths for pinned tau-Knowledge data.",
  "src/benchmark/tau-knowledge/dataset-adapter.ts": "Pins, validates, and adapts the public tau-Knowledge document corpus without reading task gold.",
  "src/benchmark/composition/ingest-evidence-benchmark.ts": "Wires benchmark sessions to SQLite ingest and optional embedding indexing.",
  "src/composition/create-retrieval-context.ts": "Wires a concrete store and optional embedder into the selected retrieval profile.",
  "src/composition/qdrant-retrieval.ts": "Builds pinned Qdrant retrieval configuration and publishes verified vector generations at the composition boundary.",
  "src/composition/scoped-qdrant-retrieval.ts": "Publishes and resolves one immutable Qdrant generation for each sealed online scope corpus.",
  "src/composition/create-read-only-navigation.ts": "Builds an optional containerized navigation binding for one immutable memory scope.",
  "src/composition/ingest-memory-workspace.ts": "Wires immutable memory sessions to SQLite ingest and optional embedding indexing.",
  "src/composition/create-search-operator-registry.ts": "Registers the allowlisted search operators and freezes their catalog for one runtime.",
  "src/composition/load-search-operator-plugins.ts": "Loads and fingerprints trusted local search-operator modules at composition time.",
  "src/composition/run-question.ts": "Builds concrete model, store, and retrieval adapters for one question run.",
  "src/entrypoints/cli/commands/benchmark-longmemeval.ts": "Executes resumable, concurrent LongMemEval benchmark runs and materializes their artifacts.",
  "src/entrypoints/cli/commands/benchmark-evidence.ts": "Executes resumable AMA-Bench retrieval-answer runs without loading evaluation labels.",
  "src/entrypoints/cli/commands/benchmark-memoryagentbench.ts": "Executes MemoryAgentBench runs through the HTTP memory boundary with explicit memory-evolution modes.",
  "src/entrypoints/cli/commands/evaluate-benchmark.ts": "Scores frozen AMA-Bench predictions at the private-label boundary.",
  "src/entrypoints/cli/commands/ingest-benchmark.ts": "Pins, selects, ingests, and manifests AMA-Bench source data.",
  "src/entrypoints/cli/commands/ingest-longmemeval.ts": "Ingests selected LongMemEval scopes and optionally builds embedding indexes.",
  "src/entrypoints/cli/commands/ingest-tau-knowledge.ts": "Validates and ingests the pinned tau-Knowledge corpus with a durable retrieval manifest.",
  "src/entrypoints/cli/commands/longmemeval-suite.ts": "Orchestrates the complete benchmark, audit, judge, frozen-reanswer, and packaging suite.",
  "src/entrypoints/cli/commands/package-benchmark.ts": "Validates complete benchmark artifacts and creates their archive.",
  "src/entrypoints/cli/commands/prepare-longmemeval-eval.ts": "Joins predictions with source answers into evaluator input records.",
  "src/entrypoints/cli/commands/run-longmemeval.ts": "Runs retrieval and answer generation for one stored private LongMemEval question.",
  "src/entrypoints/cli/commands/run-memory.ts": "Runs one arbitrary question against a selected memory scope.",
  "src/entrypoints/cli/main.ts": "Routes CLI commands and normalizes top-level errors.",
  "src/entrypoints/cli/evidence-benchmark-runtime.ts": "Provides shared model-role, provenance-hash, corpus-hash, and resumable-manifest utilities.",
  "src/entrypoints/cli/parse-command.ts": "Parses CLI arguments, validates flags, and derives model and retrieval options.",
  "src/entrypoints/cli/private-records.ts": "Binds benchmark question and scope identities to the private JSONL adapter.",
  "src/entrypoints/cli/workflow-files.ts": "Provides atomic workflow file writes, optional JSON reads, and archive command execution.",
  "src/entrypoints/tau-knowledge-bridge/main.ts": "Bridges official tau2 messages and environment tools to one stateful Picorer Agent session.",
  "src/entrypoints/ldbd-api/contracts.ts": "Validates and normalizes the LDBD Add/Search wire contracts.",
  "src/entrypoints/ldbd-api/inbox-store.ts": "Persists idempotent LDBD Add requests without benchmark questions or gold fields.",
  "src/entrypoints/ldbd-api/main.ts": "Starts the authenticated HTTP server for the LDBD memory API.",
  "src/entrypoints/ldbd-api/picorer-runtime.ts": "Materializes LDBD user messages as immutable scopes and runs Picorer retrieval.",
  "src/entrypoints/ldbd-api/service.ts": "Maps validated LDBD requests to inbox persistence and Picorer search.",
  "src/entrypoints/memoryarena-public-api/application.ts": "Serializes each MemoryArena user's lifecycle and maps the official API envelopes to the injected backend.",
  "src/entrypoints/memoryarena-public-api/contracts.ts": "Validates exact official MemoryArena initialize, add, and wrap request bodies while rejecting gold-bearing fields.",
  "src/entrypoints/memoryarena-public-api/http-errors.ts": "Maps typed Picorer runtime failures to stable, privacy-safe MemoryArena HTTP errors.",
  "src/entrypoints/memoryarena-public-api/main.ts": "Starts the drop-in MemoryArena memory HTTP gateway backed by Picorer.",
  "src/entrypoints/memoryarena-public-api/runtime-contract.ts": "Builds and hashes the formal MemoryArena retrieval runtime contract independently of persistent-store identity.",
  "src/evidence-agent/adapters/docker/read-only-shell.ts": "Runs allowlisted read-only shell commands in the memory-scope container.",
  "src/evidence-agent/adapters/pi/ephemeral-context.ts": "Builds the bounded ephemeral context passed to the Pi agent.",
  "src/evidence-agent/adapters/pi/memory-observation.ts": "Projects the retrieval ledger into one simple, cumulative model-facing memory snapshot.",
  "src/evidence-agent/adapters/pi/assistant-messages.ts": "Normalizes assistant text, response-model identity, and accumulated usage from Pi messages.",
  "src/evidence-agent/adapters/pi/retrieval-prompt.ts": "Loads the retrieval Skill and renders the core system prompt with the active operator catalog.",
  "src/evidence-agent/adapters/pi/tools.ts": "Exports the Pi tool adapter API from its responsibility-specific modules.",
  "src/evidence-agent/adapters/pi/tools/bash-tool.ts": "Adapts the read-only shell capability to the Pi bash tool contract.",
  "src/evidence-agent/adapters/pi/tools/candidate-details.ts": "Projects candidate details without duplicating exact passage content already present in the preview.",
  "src/evidence-agent/adapters/pi/tools/candidate-refs.ts": "Resolves and validates candidate references used by agent tools.",
  "src/evidence-agent/adapters/pi/tools/contracts.ts": "Defines stores, runtime state, and shared contracts required by Pi tools.",
  "src/evidence-agent/adapters/pi/tools/create-tools.ts": "Creates the complete Pi tool set for one evidence-agent run.",
  "src/evidence-agent/adapters/pi/tools/define-operator-tool.ts": "Maps a compact Agent request to one validated run-local declarative search operator.",
  "src/evidence-agent/adapters/pi/tools/finish-tool.ts": "Closes retrieval and packages every exact source read with harness-owned provenance metadata.",
  "src/evidence-agent/adapters/pi/tools/read-tool.ts": "Projects exact bounded excerpts from candidate memories and registers them as evidence.",
  "src/evidence-agent/adapters/pi/tools/render-tool-result.ts": "Renders structured tool results into the text observed by the agent.",
  "src/evidence-agent/adapters/pi/tools/schemas.ts": "Defines TypeBox input schemas for the Pi tools.",
  "src/evidence-agent/adapters/pi/tools/search-tool.ts": "Adapts retrieval orchestration to the Pi search-memory tool.",
  "src/evidence-agent/adapters/pi/tools/tool-protocol.ts": "Defines tool-call counting, time limits, and protocol errors.",
  "src/evidence-agent/model/evidence.ts": "Defines candidates, evidence, citations, metrics, and final agent results.",
  "src/evidence-agent/model/source-evidence.ts": "Builds bounded, source-hash-bound evidence projections from immutable memories.",
  "src/evidence-agent/model/source-preview-spans.ts": "Bounds legacy candidate previews and locates their verbatim fragments in immutable source text.",
  "src/evidence-agent/model/ledger.ts": "Tracks searched candidates, bounded exact reads, evidence, and provenance during a run.",
  "src/evidence-agent/model/operator-evolution.ts": "Defines audited observations and candidate proposals for evolving reusable retrieval operators from completed runs.",
  "src/evidence-agent/ports/read-only-navigation.ts": "Defines the optional read-only navigation capability injected into an evidence-agent run.",
  "src/evidence-agent/adapters/pi/run-agent.ts": "Runs the Pi evidence agent and assembles its source-grounded result.",
  "src/memory/ingest-memory-sessions.ts": "Validates and ingests immutable memory sessions through the ingest port.",
  "src/memory/model/memory.ts": "Defines source-memory, session, scope, ingest, and export domain models.",
  "src/memory/ports/memory-ingest-store.ts": "Defines the store operations required by the memory ingest use case.",
  "src/platform/concurrency/async-pool.ts": "Runs bounded concurrent work with stable slot identities.",
  "src/platform/concurrency/request-gate.ts": "Limits concurrent requests and request-start rate.",
  "src/platform/filesystem/jsonl-writer.ts": "Serializes append-only JSONL writes through a single promise chain.",
  "src/platform/filesystem/export-memory-scope.ts": "Atomically publishes exact source exports and verifies immutable snapshots before reusing existing directories.",
  "src/platform/filesystem/private-jsonl.ts": "Atomically merges permission-restricted JSONL records by caller-defined immutable identity.",
  "src/platform/pi/load-model-runtime.ts": "Loads and validates the configured Pi model runtime.",
  "src/platform/pi/model-runtime-adapter.ts": "Defines freely registered model-protocol adapters for runtime-selected model IDs.",
  "src/platform/http/runtime-fetch.ts": "Aligns native HTTP deadlines with configured request timeouts and preserves underlying transport error codes.",
  "src/platform/pi/openai-non-stream-transport.ts": "Adapts complete OpenAI Chat Completions responses to the Pi agent event protocol.",
  "src/platform/security/protected-environment.ts": "Loads permission-restricted environment files and validates required variables.",
  "src/platform/sqlite/memory-row.ts": "Maps the shared SQLite memory row shape to the memory domain model.",
  "src/platform/sqlite/float32-vector.ts": "Encodes and validates portable Float32 embedding blobs at the SQLite boundary.",
  "src/platform/sqlite/picorer-store.ts": "Provides the shared SQLite facade for memory persistence and injected retrieval indexes.",
  "src/platform/sqlite/vector-index-state-store.ts": "Implements durable vector-generation and synchronization-outbox state in SQLite.",
  "src/retrieval/adapters/qdrant/client.ts": "Implements filtered Qdrant collection, upsert, count, and HNSW search operations over HTTP.",
  "src/retrieval/adapters/qdrant/dense-retriever.ts": "Hydrates Qdrant HNSW hits from SQLite and rejects any immutable-provenance mismatch.",
  "src/retrieval/adapters/qdrant/vector-synchronizer.ts": "Publishes resumable immutable vector generations to Qdrant and verifies index readiness and counts.",
  "src/retrieval/adapters/fallback-dense-retriever.ts": "Recovers through a secondary dense retriever only when the primary reports typed unavailability.",
  "src/retrieval/adapters/openai/openai-compatible-embedder.ts": "Implements the embedder port with an OpenAI-compatible embeddings endpoint.",
  "src/retrieval/adapters/operators/builtins.ts": "Implements the built-in search operators over injected retrieval capabilities.",
  "src/retrieval/adapters/sqlite/database-evidence-operators.ts": "Implements temporal and numeric evidence-operator queries over SQLite.",
  "src/retrieval/adapters/sqlite/evidence-fact-index.ts": "Builds and inspects normalized temporal and numeric fact indexes in SQLite.",
  "src/retrieval/adapters/sqlite/exact-dense-retriever.ts": "Provides the exact SQLite dense-retrieval regression oracle behind the dense retriever port.",
  "src/retrieval/adapters/sqlite/lexical-retriever.ts": "Implements SQLite FTS query planning and lexical ranking behind the retrieval boundary.",
  "src/retrieval/finalize-search-hits.ts": "Orders retrieval hits and applies session breadth before the final candidate cutoff.",
  "src/retrieval/index-scope-embeddings.ts": "Builds or refreshes the embedding index for one memory scope.",
  "src/retrieval/model/embedder.ts": "Defines the technology-neutral embedding port.",
  "src/retrieval/model/embedding.ts": "Defines embedding profiles, stored vectors, and embedding-index contracts.",
  "src/retrieval/model/passage.ts": "Builds deterministic exact passage views over immutable parent memories and preserves source offsets.",
  "src/retrieval/model/search.ts": "Defines retrieval requests, hits, evidence sidecars, profiles, and metrics.",
  "src/retrieval/model/operator.ts": "Defines CandidateSets, executable operator contracts, and declarative run-local operator definitions.",
  "src/retrieval/operators/hybrid-search.ts": "Combines FTS and vector results using reciprocal-rank fusion.",
  "src/retrieval/operators/numeric-operator.ts": "Normalizes numeric constraints and executes numeric evidence queries.",
  "src/retrieval/operators/temporal-operator.ts": "Normalizes temporal constraints and executes temporal evidence queries.",
  "src/retrieval/ports/memory-tool-store.ts": "Defines the candidate-search and exact-read capabilities used by retrieval and evidence tools.",
  "src/retrieval/ports/dense-retriever.ts": "Defines the internal dense candidate-discovery boundary shared by exact and Qdrant implementations.",
  "src/retrieval/ports/hybrid-search-store.ts": "Defines persistence capabilities required by hybrid retrieval policy.",
  "src/retrieval/ports/operator-catalog.ts": "Defines read-only and run-private operator catalog capabilities used across retrieval boundaries.",
  "src/retrieval/ports/search-operator.ts": "Defines the stable candidate-only search-operator SPI.",
  "src/retrieval/ports/search-operator-plugin.ts": "Defines the deploy-time factory contract implemented by trusted local operator modules.",
  "src/retrieval/ports/vector-index-state-store.ts": "Defines the durable state-machine port used to publish immutable external vector generations.",
  "src/retrieval/ranking.ts": "Defines deterministic retrieval ranking and reciprocal-rank fusion helpers.",
  "src/retrieval/retrieval-profile.ts": "Resolves retrieval-profile names and creates profile-specific stores.",
  "src/retrieval/use-cases/search.ts": "Normalizes Agent search calls and dispatches them through the current run catalog.",
  "src/retrieval/search-explicit-date-routes.ts": "Batches dense lookups for identical explicit date windows while preserving per-query rankings and provenance.",
  "src/retrieval/structured-query-constraints.ts": "Extracts unambiguous structured constraints already present in Agent-authored retrieval queries.",
  "src/retrieval/temporal-annotation.ts": "Parses and annotates temporal facts present in memory text.",
  "src/retrieval/use-cases/execute-operator.ts": "Executes one registered search operator and enforces result scope isolation.",
  "src/retrieval/model/source-time.ts": "Validates source calendar dates and timezone-aware instants and orders immutable memories.",
  "src/retrieval/model/hit-provenance.ts": "Merges query paths and structured source coordinates when retrieval routes meet.",
  "src/retrieval/use-cases/operator-definition.ts": "Normalizes and validates bounded declarative operator graphs and computes their identity.",
  "src/retrieval/use-cases/operator-discovery.ts": "Propagates compatible discovery constraints through shared graph consumers without crossing lossy transformations.",
  "src/retrieval/use-cases/candidate-set.ts": "Combines and transforms ranked candidate sets while retaining applicable source annotations.",
  "src/retrieval/use-cases/compose-operator.ts": "Executes validated retrieval graphs and records per-step candidate and query traces.",
  "src/retrieval/use-cases/operator-registry.ts": "Owns the frozen base catalog plus isolated, versioned run-local operator overlays.",
  "src/util.ts": "Provides shared hashing, safe path, source-text, and preview helpers.",
}));

const FUNCTION_PURPOSES = new Map(Object.entries({
  "src/benchmark/model/answer.ts#returnedModelMatches": "Checks whether the provider's response model matches the requested model.",
  "src/benchmark/longmemeval/data-paths.ts#dataPaths": "Derives all persistent LongMemEval paths from one data directory.",
  "src/evidence-agent/adapters/pi/tools/search-tool.ts#createSearchTool": "Creates the Pi search tool that delegates retrieval and records returned candidates in the ledger.",
  "src/evidence-agent/adapters/pi/tools/define-operator-tool.ts#createDefineOperatorTool": "Creates the compact Agent tool that assembles existing operators into one run-local operator.",
  "src/evidence-agent/adapters/pi/run-agent.ts#questionPrompt": "Builds the user prompt from the question and optional question date.",
  "src/evidence-agent/adapters/pi/run-agent.ts#runPicorer": "Runs one bounded evidence-agent session and returns its provenance-backed result.",
  "src/composition/create-search-operator-registry.ts#createSearchOperatorRegistry": "Registers built-in and additional operators, then freezes the catalog.",
  "src/composition/create-search-operator-registry.ts#createSelectedSearchOperatorRegistry": "Registers an explicit allowlist of built-in and additional operators for one run.",
  "src/retrieval/adapters/operators/builtins.ts#builtInSearchOperators": "Creates the built-in search-operator implementations over one injected store.",
  "src/retrieval/use-cases/execute-operator.ts#executeSearchOperator": "Runs a registered operator and rejects candidate hits from another scope.",
  "src/retrieval/use-cases/compose-operator.ts#buildDeclarativeSearchOperator": "Validates a bounded operator graph and builds a candidate-only executable operator.",
  "src/retrieval/use-cases/operator-registry.ts#SearchOperatorRegistry.register": "Validates and registers one uniquely named search operator before freeze.",
  "src/retrieval/use-cases/operator-registry.ts#SearchOperatorRegistry.freeze": "Seals the catalog after verifying its default operator exists.",
  "src/retrieval/use-cases/operator-registry.ts#SearchOperatorRegistry.get": "Resolves an allowlisted operator or reports the available catalog.",
  "src/retrieval/use-cases/operator-registry.ts#SearchOperatorRegistry.list": "Returns a detached runtime catalog for schemas, prompts, and manifests.",
  "src/retrieval/use-cases/operator-registry.ts#SearchOperatorRegistry.forkForRun": "Creates an isolated mutable overlay over the frozen base catalog.",
  "src/retrieval/use-cases/operator-registry.ts#RunSearchOperatorCatalog.define": "Validates and registers one declarative operator only within the current run.",
  "src/retrieval/use-cases/operator-registry.ts#RunSearchOperatorCatalog.identity": "Hashes the frozen base catalog and ordered run-local definitions.",
  "src/retrieval/use-cases/operator-registry.ts#RunSearchOperatorCatalog.snapshots": "Returns detached normalized definitions for audit and later promotion.",
  "src/retrieval/use-cases/operator-registry.ts#RunSearchOperatorCatalog.remainingDefinitions": "Reports the remaining bounded definition capacity for the current run.",
  "src/retrieval/use-cases/operator-registry.ts#renderSearchOperatorCatalog": "Renders operator capabilities into the catalog shown to the agent.",
  "src/entrypoints/ldbd-api/contracts.ts#parseAddRequest": "Validates one synchronous LDBD Add request and keeps only the memory contract fields.",
  "src/entrypoints/ldbd-api/contracts.ts#parseSearchRequest": "Validates one LDBD Search request with a bounded top-k and optional choices.",
  "src/entrypoints/ldbd-api/contracts.ts#renderRetrievalQuestion": "Adds benchmark options to the retrieval question without persisting them as memory.",
  "src/entrypoints/ldbd-api/inbox-store.ts#LdbdInboxStore.put": "Persists an Add request idempotently and rejects request-ID content conflicts.",
  "src/entrypoints/ldbd-api/inbox-store.ts#LdbdInboxStore.listForUser": "Returns one user's Add requests in durable insertion order.",
  "src/entrypoints/ldbd-api/picorer-runtime.ts#PicorerLdbdRuntime.search": "Builds an immutable user snapshot, runs Picorer, and returns cited memories in LDBD form.",
  "src/entrypoints/ldbd-api/service.ts#LdbdApiService.add": "Handles the synchronous LDBD Add operation.",
  "src/entrypoints/ldbd-api/service.ts#LdbdApiService.search": "Handles the LDBD Search operation through the injected search engine.",
  "src/retrieval/use-cases/search.ts#normalizeStrings": "Validates, trims, and deduplicates a list of search values.",
  "src/retrieval/use-cases/search.ts#makeSearchRequest": "Builds a normalized retrieval request with stable default limits and ordering.",
  "src/retrieval/use-cases/search.ts#searchQueryFingerprint": "Creates a canonical fingerprint used to detect repeated queries.",
  "src/retrieval/use-cases/search.ts#mergeOperatorHits": "Merges operator-preferred and fallback hits without duplicate memories.",
  "src/retrieval/use-cases/search.ts#coverageHits": "Runs each coverage query and merges deterministic session-diverse results under one budget.",
  "src/retrieval/use-cases/search.ts#createSearchMemory": "Creates the search orchestrator for normalization, routing, coverage, expansion, and hit merging.",
  "src/platform/sqlite/picorer-store.ts#ftsQuery": "Converts free text into a bounded, escaped SQLite FTS5 OR query.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.ingestScope": "Atomically persists one immutable memory scope and reports whether it was inserted or reused.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.search": "Executes filtered FTS5 search and returns finalized retrieval hits.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.read": "Reads exact memories by ID within one scope.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.listScopeIds": "Lists immutable memory scope IDs in stable order for whole-corpus derived-index publication.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.getVectorGenerationScopeCount": "Returns one generation's durable vector count for a scope-level fail-closed retrieval check.",
  "src/platform/sqlite/picorer-store.ts#MemoryStore.exportScope": "Writes a sanitized, permission-restricted filesystem export of one scope.",
  "src/platform/pi/openai-non-stream-transport.ts#resolvedMessageCompat": "Resolves the OpenAI message-conversion compatibility settings for a model.",
  "src/platform/pi/openai-non-stream-transport.ts#requestHeaders": "Builds authenticated JSON request headers without persisting the API key.",
  "src/platform/pi/openai-non-stream-transport.ts#serializedTools": "Serializes Pi function tools for an OpenAI-compatible request.",
  "src/platform/pi/openai-non-stream-transport.ts#buildPayload": "Builds a non-streaming Chat Completions request from Pi model context.",
  "src/platform/pi/openai-non-stream-transport.ts#asObject": "Validates that an untrusted protocol value is a JSON object.",
  "src/platform/pi/openai-non-stream-transport.ts#nonNegativeInteger": "Normalizes an untrusted usage counter to a non-negative integer.",
  "src/platform/pi/openai-non-stream-transport.ts#responseUsage": "Maps provider token usage and model rates to Pi usage metadata.",
  "src/platform/pi/openai-non-stream-transport.ts#responseText": "Extracts text from an OpenAI-compatible assistant response.",
  "src/platform/pi/openai-non-stream-transport.ts#responseThinking": "Extracts optional reasoning text and its provider field name.",
  "src/platform/pi/openai-non-stream-transport.ts#responseToolCalls": "Validates and maps complete provider tool calls to Pi tool-call blocks.",
  "src/platform/pi/openai-non-stream-transport.ts#finishReason": "Maps an OpenAI finish reason to the Pi stop-reason contract.",
  "src/platform/pi/openai-non-stream-transport.ts#errorMessageFromBody": "Extracts a bounded provider error message from an HTTP response body.",
  "src/platform/pi/openai-non-stream-transport.ts#emitCompletedMessage": "Emits one complete assistant response through the Pi event protocol.",
  "src/platform/pi/openai-non-stream-transport.ts#openAINonStreamingStreamFn": "Executes one non-streaming Chat Completions request and exposes it as a Pi event stream.",
  "src/evidence-agent/model/ledger.ts#MemoryLedger.recordSearchHits": "Registers retrieval hits as candidates while preserving first-seen provenance.",
  "src/evidence-agent/model/ledger.ts#MemoryLedger.recordRead": "Registers bounded exact memory reads and promotes them to eligible evidence.",
  "src/evidence-agent/model/ledger.ts#MemoryLedger.finish": "Validates and stores the agent's final evidence selection.",
  "src/evidence-agent/model/ledger.ts#MemoryLedger.assertInvariants": "Verifies candidate, evidence, citation, and scope provenance invariants.",
}));

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

function lineNumber(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function visibility(node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ? "exported"
    : "internal";
}

function parameters(node, sourceFile) {
  return node.parameters
    .map((parameter) => parameter.getText(sourceFile).replace(/\s+/gu, " "))
    .join(", ");
}

function returnType(node, sourceFile) {
  return node.type ? `: ${node.type.getText(sourceFile).replace(/\s+/gu, " ")}` : "";
}

function jsDocPurpose(node) {
  const documentation = ts.getJSDocCommentsAndTags(node)
    .find((item) => ts.isJSDoc(item));
  if (!documentation?.comment) return undefined;
  const comment = typeof documentation.comment === "string"
    ? documentation.comment
    : documentation.comment.map((part) => part.text).join("");
  const normalized = comment.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/u)?.[0] ?? normalized;
  return sentence.trim();
}

function humanizeIdentifier(identifier) {
  return identifier
    .replace(/^#/, "")
    .replace(/[_-]+/gu, " ")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function inferredPurpose(identifier, kind, className) {
  if (kind === "class") return `Implements ${humanizeIdentifier(identifier)}.`;
  if (identifier === "constructor") {
    return `Creates a ${humanizeIdentifier(className)} instance.`;
  }
  const exactOperations = new Map([
    ["search", "Performs a search."],
    ["read", "Reads the requested value."],
    ["load", "Loads the requested resource."],
    ["run", "Runs the operation."],
    ["close", "Closes owned resources."],
  ]);
  if (exactOperations.has(identifier)) return exactOperations.get(identifier);
  const rules = [
    ["assert", "Validates", " and throws when invalid"],
    ["normalize", "Normalizes", ""],
    ["materialize", "Materializes", ""],
    ["finalize", "Finalizes", ""],
    ["serialize", "Serializes", ""],
    ["deserialize", "Deserializes", ""],
    ["create", "Creates", ""],
    ["build", "Builds", ""],
    ["collect", "Collects", ""],
    ["compare", "Compares", ""],
    ["execute", "Executes", ""],
    ["prepare", "Prepares", ""],
    ["package", "Packages", ""],
    ["resolve", "Resolves", ""],
    ["register", "Registers", ""],
    ["validate", "Validates", ""],
    ["render", "Renders", ""],
    ["adapt", "Adapts", ""],
    ["parse", "Parses", ""],
    ["merge", "Merges", ""],
    ["search", "Searches", ""],
    ["index", "Indexes", ""],
    ["load", "Loads", ""],
    ["read", "Reads", ""],
    ["write", "Writes", ""],
    ["run", "Runs", ""],
    ["get", "Returns", ""],
    ["set", "Sets", ""],
    ["to", "Converts", ""],
  ];
  for (const [prefix, verb, suffix] of rules) {
    if (!identifier.startsWith(prefix) || identifier.length === prefix.length) continue;
    return `${verb} ${humanizeIdentifier(identifier.slice(prefix.length))}${suffix}.`;
  }
  for (const prefix of ["is", "has", "can", "should"]) {
    if (!identifier.startsWith(prefix) || identifier.length === prefix.length) continue;
    return `Checks whether ${humanizeIdentifier(identifier.slice(prefix.length))}.`;
  }
  return `Implements the ${humanizeIdentifier(identifier)} operation.`;
}

function purpose(node, identifier, kind, className) {
  const projectPath = relative(projectRoot, node.getSourceFile().fileName)
    .replace(/\\/gu, "/");
  const key = `${projectPath}#${className ? `${className}.` : ""}${identifier}`;
  return FUNCTION_PURPOSES.get(key) ??
    jsDocPurpose(node) ??
    inferredPurpose(identifier, kind, className);
}

function memberVisibility(node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) {
    return "private";
  }
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ProtectedKeyword)) {
    return "protected";
  }
  return "public";
}

function declarationRows(sourceFile) {
  const rows = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      rows.push({
        symbol: `${statement.name.text}(${parameters(statement, sourceFile)})${returnType(statement, sourceFile)}`,
        kind: "function",
        visibility: visibility(statement),
        purpose: purpose(statement, statement.name.text, "function"),
        line: lineNumber(sourceFile, statement),
      });
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      rows.push({
        symbol: statement.name.text,
        kind: "class",
        visibility: visibility(statement),
        purpose: purpose(statement, statement.name.text, "class"),
        line: lineNumber(sourceFile, statement),
      });
      for (const member of statement.members) {
        if (
          (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) ||
          (!ts.isConstructorDeclaration(member) && !member.name)
        ) continue;
        const memberName = ts.isConstructorDeclaration(member)
          ? "constructor"
          : member.name.getText(sourceFile);
        rows.push({
          symbol: `${statement.name.text}.${memberName}(${parameters(member, sourceFile)})${returnType(member, sourceFile)}`,
          kind: "method",
          visibility: memberVisibility(member),
          purpose: purpose(member, memberName, "method", statement.name.text),
          line: lineNumber(sourceFile, member),
        });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))
      ) {
        continue;
      }
      rows.push({
        symbol: `${declaration.name.text}(${parameters(declaration.initializer, sourceFile)})${returnType(declaration.initializer, sourceFile)}`,
        kind: "function",
        visibility: visibility(statement),
        purpose: purpose(declaration, declaration.name.text, "function"),
        line: lineNumber(sourceFile, declaration),
      });
    }
  }
  return rows;
}

function markdown(files) {
  const sections = files.map(({ projectPath, rows }) => {
    const body = rows.length === 0
      ? "_No top-level functions, classes, or class methods._"
      : [
          "| Symbol | Purpose | Kind | Visibility | Source |",
          "|---|---|---|---|---|",
          ...rows.map((row) =>
            `| \`${row.symbol.replace(/\|/gu, "\\|")}\` | ${row.purpose.replace(/\|/gu, "\\|")} | ${row.kind} | ${row.visibility} | [line ${row.line}](../../${projectPath.replace(/\\/gu, "/")}#L${row.line}) |`
          ),
        ].join("\n");
    return `## \`${projectPath.replace(/\\/gu, "/")}\`\n\n${body}`;
  });
  return [
    "# Code Catalog",
    "",
    "This file is generated from the TypeScript AST. It is the function-level directory for the project and must not be edited manually.",
    "",
    "Run `npm run docs:catalog` after adding, removing, renaming, or moving source symbols.",
    "",
    ...sections,
    "",
  ].join("\n");
}

function contextFor(projectPath) {
  const [, topLevel] = projectPath.split("/");
  if (new Set([
    "src/cli.ts",
    "src/memoryarena-public-api.ts",
    "src/tau-knowledge-bridge.ts",
  ]).has(projectPath)) return "entrypoints";
  const contexts = new Set(["memory", "retrieval", "evidence-agent", "agent-runtime", "benchmark"]);
  if (contexts.has(topLevel)) return topLevel;
  if (["entrypoints", "composition", "platform"].includes(topLevel)) return topLevel;
  return projectPath === "src/util.ts" ? "shared" : "compatibility";
}

function isCompatibilityFacade(projectPath, source) {
  return contextFor(projectPath) === "compatibility" ||
    source.includes("Compatibility facade");
}

function layerFor(projectPath, source) {
  if (isCompatibilityFacade(projectPath, source)) return "compatibility facade";
  if (new Set([
    "src/cli.ts",
    "src/memoryarena-public-api.ts",
    "src/tau-knowledge-bridge.ts",
  ]).has(projectPath)) return "entry point";
  if (projectPath.endsWith("/index.ts")) return "public API";
  if (projectPath.includes("/model/")) return "model";
  if (projectPath.includes("/ports/")) return "port";
  if (projectPath.includes("/adapters/")) return "adapter";
  if (projectPath.includes("/operators/")) return "operator";
  if (projectPath.includes("/use-cases/")) return "use case";
  if (projectPath.includes("/composition/")) return "composition root";
  if (projectPath.includes("/prompts/")) return "prompt policy";
  if (projectPath.includes("/entrypoints/cli/commands/")) return "command handler";
  if (projectPath === "src/entrypoints/cli/main.ts") return "entry point";
  if (projectPath.startsWith("src/entrypoints/")) return "entrypoint support";
  if (projectPath.startsWith("src/composition/")) return "composition root";
  if (projectPath.startsWith("src/platform/")) return "platform adapter";
  return "domain service";
}

function facadeResponsibility(source) {
  const targets = [...source.matchAll(/(?:from\s+|import\s*)["'](.+?)["']/gu)]
    .map((match) => `\`${match[1]}\``);
  return targets.length === 0
    ? "Preserves a pre-refactor import path."
    : `Preserves a pre-refactor import path by re-exporting ${targets.join(", ")}.`;
}

function fileResponsibility(projectPath, source) {
  if (isCompatibilityFacade(projectPath, source)) return facadeResponsibility(source);
  const configured = FILE_RESPONSIBILITIES.get(projectPath);
  if (configured) return configured;
  if (projectPath.endsWith("/index.ts")) {
    return `Defines the public API exported by the ${contextFor(projectPath)} context.`;
  }
  throw new Error(`Missing file responsibility for ${projectPath}`);
}

function fileCatalogMarkdown(files) {
  let hasCompatibilityFacade = false;
  const rows = files.map(({ projectPath, source }) => {
    const layer = layerFor(projectPath, source);
    hasCompatibilityFacade ||= layer === "compatibility facade";
    const status = layer === "compatibility facade"
      ? "compatibility"
      : layer === "public API"
        ? "public"
        : "internal";
    return `| [\`${projectPath}\`](../../${projectPath}) | ${contextFor(projectPath)} | ${layer} | ${status} | ${fileResponsibility(projectPath, source)} |`;
  });
  return [
    "# File Catalog",
    "",
    "This generated catalog is the file-level directory for the project. Responsibilities are maintained in `scripts/generate-code-catalog.mjs`; generation fails when a primary source file has no description.",
    "",
    hasCompatibilityFacade
      ? "Compatibility facades preserve old import paths during structural migration. New code must import the canonical context path."
      : "All source modules use canonical context paths; no source-level compatibility facades remain.",
    "",
    "| File | Context | Layer | Status | Responsibility |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const files = await listTypeScriptFiles(sourceRoot);
const catalogEntries = await Promise.all(files.map(async (path) => {
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return {
    projectPath: relative(projectRoot, path).replace(/\\/gu, "/"),
    source,
    rows: declarationRows(sourceFile),
  };
}));
const generatedCodeCatalog = markdown(catalogEntries);
const generatedFileCatalog = fileCatalogMarkdown(catalogEntries);

if (process.argv.includes("--check")) {
  const [currentCodeCatalog, currentFileCatalog] = await Promise.all([
    readFile(codeCatalogPath, "utf8").catch(() => ""),
    readFile(fileCatalogPath, "utf8").catch(() => ""),
  ]);
  if (
    currentCodeCatalog !== generatedCodeCatalog ||
    currentFileCatalog !== generatedFileCatalog
  ) {
    throw new Error("Architecture catalogs are stale. Run `npm run docs:catalog`.");
  }
} else {
  await Promise.all([
    writeFile(codeCatalogPath, generatedCodeCatalog, "utf8"),
    writeFile(fileCatalogPath, generatedFileCatalog, "utf8"),
  ]);
}
