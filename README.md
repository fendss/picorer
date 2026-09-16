# Picorer

Picorer is a minimal memory-agent runtime built on `pi-agent-core`.

Its contract is deliberately small:

```text
immutable raw memory
        ↓
search / read / bash_ro
        ↓
Pi Agent searches and reads exact evidence
        ↓
finish({ status, evidenceSummary })
        ↓
harness-owned evidence package → caller-owned answer adapter
```

For offline QA, every exact source read by the retrieval agent is retained and
deduplicated by the harness. Picorer stops at that cited evidence package. It does not own
answer formatting or a universal answer prompt; each benchmark adapter supplies
its own answer protocol. For an interactive environment, the same Agent keeps
the search/read loop and delegates environment actions back to the official
runner. Ingest never invokes a generative model.

## Architecture navigation

- [`docs/architecture/README.md`](docs/architecture/README.md) explains the bounded contexts and dependency direction.
- [`docs/architecture/file-catalog.md`](docs/architecture/file-catalog.md) states what every source file owns.
- [`docs/architecture/code-catalog.md`](docs/architecture/code-catalog.md) states what every function, class, and class method does.
- [`docs/picorer-v1.0.0/README.md`](docs/picorer-v1.0.0/README.md) is the complete v1.0.0 system, implementation, evaluation, and operations guide.
- [`RELEASE.md`](RELEASE.md) defines the independent v1.0.0 public release boundary.
- [`deploy/README.md`](deploy/README.md) documents the Dockerized LDBD Add/Search API.
- [`experiments/README.md`](experiments/README.md) describes the released evidence--sufficiency data, analysis code, and integrity records.

## Current capabilities

- deterministic TypeScript ingest and an immutable SQLite source store;
- SQLite FTS5 plus optional exact or Qdrant HNSW dense retrieval and RRF;
- Agent-routed `hybrid`, `lexical`, `coverage`, `temporal`, `numeric`, and `history` search operators behind a three-field API;
- harness-owned scope enforcement, prepared SQL, session aggregation, fact joins, ranking, and provenance;
- resumable Float32 derived embeddings and immutable, verified Qdrant index generations that never modify raw memory;
- exact `read` with neighboring source turns;
- networkless, read-only Docker shell over one sanitized scope;
- Pi Core retrieval-agent loop where `read` retains exact evidence and the
  harness owns citation, provenance, deduplication, and package formatting;
- `finish` with an explicit `sufficient` / `insufficient` coverage signal and
  concise synthesis; the harness automatically commits every exact source
  returned by `read`;
- benchmark integrations for LongMemEval-S, AMA-Bench v4, and the official
  τ-Knowledge interactive environment;
- automatic candidate, evidence, citation and tool-trace export;
- trusted LongMemEval-S adapter with memory/private/gold separation.

The runtime enforces that the final cited package is the deduplicated exact-read
ledger:

```text
Citations = Evidence = Exact reads ⊆ Candidates
```

Search previews and shell output are candidates only. A memory must be
successfully read in the current run before the harness can include it at
`finish`.

## Leakage boundary

The LongMemEval adapter constructs memory from this whitelist only:

```text
conversation.speaker_a
conversation.speaker_b
conversation.session_N_date_time
conversation.session_N[].dia_id
conversation.session_N[].speaker
conversation.session_N[].text
```

Question text and raw question ID are written to `private/questions.jsonl`,
which is used by the runner but is never mounted into `bash_ro`. Answers,
evidence labels, categories, answer-session IDs and benchmark metadata are
never copied into Picorer data.

## Ingest and search flow

Raw ingest always runs before derived indexing:

```text
LongMemEval adapter whitelist
  -> sanitized source turns
  -> immutable memories rows + FTS5 rows
  -> scope-only read-only export
  -> optional missing embedding rows for picorer-hybrid profiles
  -> optional durable outbox -> verified Qdrant generation
```

A raw scope that already exists byte-for-byte reports `status: unchanged`; this
means ingest was verified as a no-op, not skipped. `picorer-hybrid` then checks its
own derived index independently and writes only missing vectors. Ingest never
calls the Pi answer model or any generative model.

The runner selects one internal search profile before creating the Agent:

```text
fts5:
  query -> scope/session/time filters -> SQLite FTS5 -> candidates

picorer-hybrid:
  query embedding -> scope-filtered dense candidates
  + SQLite FTS5 candidates
  -> RRF(dense, FTS5, k=60) -> candidates

picorer-hybrid-qdrant-hnsw-v1:
  query embedding -> generation/scope/session/role/time-filtered Qdrant HNSW
  + SQLite FTS5 candidates
  -> hydrate and revalidate immutable provenance in SQLite
  -> RRF(HNSW dense, FTS5, k=60) -> candidates
  -> on typed Qdrant availability failure, retry dense with exact SQLite search
```

The Agent routes one `search` call with only `operator`, `queries`, and optional
`limit`. Operators are `hybrid`, `lexical`, `coverage`, `temporal`, `numeric`,
and `history`. Their SQL, per-query coverage, session aggregation, fact joins,
and provenance stay inside the harness; no question-keyword routing or
model-authored SQL is used. The Agent still sees only `search`, `read`,
`bash_ro`, and `finish`. Search results become candidates, `read` promotes exact
raw records to evidence, and only read evidence may be cited by `finish`.

## Commands

Node 22.19 or newer is required. The full benchmark suite also requires
Python 3 and the packages in `requirements-dev.txt`.

```bash
npm install
python3 -m pip install -r requirements-dev.txt
npm run build

npm run cli -- ingest-longmemeval \
  --source /path/to/longmemeval_s_cleaned_converted.json \
  --data-dir ./data \
  --question-id e47becba

npm run cli -- run-longmemeval \
  --data-dir ./data \
  --question-id e47becba

npm run cli -- benchmark-longmemeval \
  --data-dir ./data \
  --output-dir ./runs/canary \
  --retrieval-profile picorer-hybrid \
  --model gpt-4o-mini \
  --slots 16

# One resumable command owns retry waves, progress, audit, packaging and Judger v5.
npm run cli -- longmemeval-suite \
  --source /path/to/longmemeval_s_cleaned_converted.json \
  --data-dir ./data \
  --output-dir ./runs/full-suite \
  --retrieval-profile picorer-hybrid \
  --embedding-env "$HOME/.config/picorer/embedding.env" \
  --retrieval-env "$HOME/.config/picorer/retrieval.env" \
  --answer-env "$HOME/.config/picorer/answer.env" \
  --judge-env "$HOME/.config/picorer/judger.env" \
  --retrieval-agent-dir "$HOME/.pi/agent" \
  --retrieval-provider picorer-openai \
  --retrieval-model gpt-5.4-mini \
  --answer-agent-dir "$HOME/.pi/agent" \
  --answer-provider picorer-openai \
  --answer-model gpt-4o-mini \
  --skill picorer-v0 \
  --slots 16 \
  --frozen-slots 16 \
  --judge-slots 16 \
  --archive ./runs/full-suite.tar.gz \
  --evaluation-archive ./runs/full-suite-evaluation.tar.gz

npm run cli -- prepare-longmemeval-eval \
  --source /path/to/longmemeval_s_cleaned_converted.json \
  --predictions ./runs/canary/predictions.jsonl \
  --output ./runs/canary/longmemeval-eval.json

npm run cli -- package-benchmark \
  --output-dir ./runs/canary \
  --archive ./runs/canary.tar.gz
```

Repeat `--question-id` to ingest more than one scope. Omitting it ingests the
full LongMemEval-S split.

All ingest/run commands default to `--retrieval-profile fts5`. To build and use
the Picorer hybrid profile, set the embedding environment without putting
secrets on the command line, then pass `--retrieval-profile
picorer-hybrid` to both ingest and run. Full indexing can additionally use
`--embedding-slots 8 --embedding-rps 6` for globally bounded asynchronous
requests:

```text
PICORER_EMBEDDING_BASE_URL
PICORER_EMBEDDING_API_KEY
PICORER_EMBEDDING_MODEL=text-embedding-v4
PICORER_EMBEDDING_DIMENSIONS=1024
PICORER_EMBEDDING_MAX_INPUT_LENGTH=2048
PICORER_EMBEDDING_BATCH_SIZE=10
```

To publish and use the Qdrant profile, provide the same embedding variables plus:

```text
PICORER_QDRANT_URL=http://127.0.0.1:6333
# Optional for an authenticated Qdrant deployment.
PICORER_QDRANT_API_KEY=
PICORER_VECTOR_GENERATION_ID=my-corpus-v1
PICORER_QDRANT_COLLECTION=picorer_vectors_v1

# Optional tuning; defaults are shown.
PICORER_QDRANT_TIMEOUT_MS=120000
PICORER_QDRANT_HNSW_M=32
PICORER_QDRANT_EF_CONSTRUCT=200
PICORER_QDRANT_HNSW_EF=800
PICORER_QDRANT_FULL_SCAN_THRESHOLD_KB=1000
PICORER_QDRANT_INDEXING_THRESHOLD_KB=10000
PICORER_QDRANT_SYNC_BATCH_SIZE=512
PICORER_QDRANT_SYNC_CONCURRENCY=4
PICORER_QDRANT_VERIFY_POLL_MS=1000
PICORER_QDRANT_VERIFY_TIMEOUT_MS=3600000
```

Use `--retrieval-profile picorer-hybrid-qdrant-hnsw-v1` for both ingest and
run. Ingest writes embeddings to SQLite, enqueues them in a durable outbox,
upserts bounded concurrent batches, verifies total and per-scope counts, and
only then marks the generation ready. Search refuses incomplete generations;
every Qdrant result is hydrated from SQLite and checked for point identity,
scope, content hash, session, role, and timestamp before it can become a
Candidate. Qdrant and SQLite exact search are alternative implementations of
one dense lane, so dense evidence receives one RRF vote. If Qdrant is
unavailable, the dense lane falls back to exact SQLite search while FTS5 stays
available, and the run records the fallback count. Configuration, generation,
scope, and provenance failures remain visible and fail closed. A generation is
immutable after sealing; use a new
`PICORER_VECTOR_GENERATION_ID` when the corpus or embedding profile changes.
Indexes produced by the earlier experimental Qdrant branch use a different
point-identity schema and must likewise be republished under a new generation.
The LDBD service selects the same backend with
`PICORER_RETRIEVAL_PROFILE=picorer-hybrid-qdrant-hnsw-v1`. It derives an immutable
generation from the configured base ID, scope ID, and sealed corpus
fingerprint, so independent users never overwrite each other.

`--embedding-slots` controls in-flight embedding requests and
`--embedding-rps` controls their global start rate. All slots share one gate;
each slot remains sequential, SQLite writes stay in short synchronous
transactions, and existing vectors are skipped on resume. The conservative
`8/6` profile matches the audited provider capacity plan while retaining the
endpoint-safe 10-input request batch. HTTP errors, network failures, timeouts,
and malformed or incomplete responses retry indefinitely at 1, 2, 4, 8, 16,
then 30 seconds. Every retry re-enters the global request gate; only explicit
abort or invalid startup configuration terminates the loop.

The hybrid profile embeds `{role}: {exact original content}`, retrieves dense
`top max(20, 4 * limit)` after applying scope/session/time filters, and reranks
only those candidates with identity order plus BM25Okapi through `RRF(k=60)`.
The endpoint, key, Authorization header, vectors, and full API response are not
written to runner output. A missing key, failed query embedding, or incomplete
scope index is an error; hybrid never silently falls back to FTS5.

`longmemeval-suite` loads only mode-`0600`, runner-owned protected environment files. Retrieval and answer files may both use the conventional `OPENAI_API_KEY` and `OPENAI_API_BASE` names: the suite reads them separately and maps them to process-only role-specific variables before starting the benchmark, so neither credential can overwrite the other. `--retrieval-env` defaults to `--answer-env` for backward compatibility. The paired `--retrieval-*` and `--answer-*` flags independently select agent directory, provider, model, thinking level, credential-variable names, base-URL-variable names, and transport. Each omitted role flag falls back to its legacy unprefixed form (`--agent-dir`, `--provider`, `--model`, `--thinking-level`, `--api-key-env`, `--base-url-env`, or `--transport`), so existing suite commands retain their behavior. The answer role also owns the frozen re-answer stage.

The suite fails fast on `401`, `403`, or invalid-token errors, while `429`, timeout, transport, and transient upstream failures remain durably resumable. The command owns progress, retry waves, completeness/provenance audit, benchmark packaging, evaluator preparation, Judger v5, a gold-isolated frozen re-answer over the current run's cited Evidence, paired comparison, and evaluation packaging.

The batch command accepts `--slots 1..256`. Each asynchronous slot runs one
fresh Agent at a time and takes the next unanswered question immediately after
its current per-question record is durable. A four-question canary wave runs
before a larger pool, and a systemic API failure opens a circuit breaker before
more questions are scheduled. Slots share one immutable database but use
independent retrieval wrappers so per-question embedding and rerank metrics do
not overlap.

Each success contains separate retrieval and benchmark-answer stages and is first written atomically under `records/`, making interruption and resume independent of concurrent JSONL appends. At batch settlement, Picorer
materializes:

- `predictions.jsonl`: compact evaluator-facing answers;
- `traces.jsonl`: complete Picorer retrieval traces plus benchmark answer metadata;
- `results.json`: one JSON document containing every durable two-stage record;
- `failures.jsonl`: unresolved per-question failures, empty after full success;
- `run-manifest.json`: question-set hash, model, normalized endpoint, retrieval
  profile, slot count, and system-prompt hash, with no credential.

Every result includes compact Candidates, selected bounded exact Evidence, citations, candidate provenance, retrieval-agent metadata, benchmark answer prompt identity/hash, answer-model metadata, retrieval metadata, and metrics. Each Evidence excerpt records source offsets and the immutable source hash; full Candidate source payloads are not duplicated into result artifacts. The retrieval skill never contains LongMemEval answer formatting rules. `package-benchmark` refuses incomplete or failed runs and creates a
`0600` tar.gz containing the consolidated artifacts plus SHA-256 checksums.
Runner outputs may contain raw question IDs and memory contents, but they are
never mounted into another Agent's memory scope.

`prepare-longmemeval-eval` is a separate evaluator-side step. Only after all
Agent runs are finished does it read gold answers/types and create the array
accepted by LongMemEval's `longmemeval_evaluate.py`.

Run commands read Pi model configuration from `~/.pi/agent` by default for
backward compatibility. For runtime-selected models, `--model-adapter` bypasses
the model catalog: provider endpoint and credential stay runtime inputs while
`--model` may be any model ID supported by that endpoint. Built-in protocol
adapters are `openai-completions`, `openai-responses`, and
`qwen-completions`; the last maps Pi thinking levels to Qwen's
`enable_thinking` request field. `--context-window` and `--max-tokens` override
adapter defaults when a service exposes different limits. The same flags accept
`retrieval-`, `answer-`, and `judge-` prefixes in benchmark commands.

Code integrations can register another `PiModelRuntimeAdapter` in
`PiModelRuntimeAdapterRegistry` without modifying provider or model catalogs.
Only a genuinely different wire protocol or compatibility behavior needs a new
adapter; changing from one model ID to another does not. Model calls default to
`--transport sse`; use `--transport non-stream` only for compatible Chat
Completions services. Provider credentials remain process-only environment
variables or trusted `!command` entries; CLI flags never accept or print keys.

### MemoryAgentBench

The pinned black-box adapter is in
[`integrations/memoryagentbench`](integrations/memoryagentbench/README.md). It
preserves the upstream task templates and answer-model boundary for the ten
selected MemoryAgentBench targets, while Picorer remains a separately started
HTTP memory service. The adapter was integrated from
`benchmark/memoryagentbench-adapters` at
`c38de25c8779c770be3f0eb8f842119406ad4875` and extended with a fixed search
budget plus three operator experiments:

- `static`: only the registered operator catalog is available;
- `ephemeral`: a question may define operators, but they are discarded before
  the next question;
- `cumulative`: evidence-contributing, query-agnostic definitions carry to the
  next question within the same benchmark context.

Each retrieval is checkpointed before the answer call, so a process interruption
resumes from the exact wrapped prompt and evolution state. Retrieval or answer
method failures are recorded once as empty, zero-score outcomes; resume cannot
resample them. Answer-provider 408/429/5xx and transport outages instead resume
from that exact pending prompt without rerunning retrieval. See the integration README for pinned data
setup, commands, scoring, and audit fields.

### AMA-Bench v4

The adapter accepts only the pinned official open-ended file: dataset revision
`a5777378066f53229a94557a7b192435cd027909`,
`test/open_end_qa_set.jsonl` (208 episodes, 2,496 questions). Ingest verifies
its exact SHA-256 before writing any data.

```bash
mkdir -p ./vendor/ama-bench/test
curl --fail --location \
  'https://huggingface.co/datasets/AMA-bench/AMA-bench/resolve/a5777378066f53229a94557a7b192435cd027909/test/open_end_qa_set.jsonl?download=true' \
  --output ./vendor/ama-bench/test/open_end_qa_set.jsonl

npm run cli -- ingest-benchmark \
  --benchmark ama-bench \
  --source ./vendor/ama-bench/test/open_end_qa_set.jsonl \
  --data-dir ./data/ama-v4 \
  --retrieval-profile fts5

npm run cli -- benchmark \
  --benchmark ama-bench \
  --data-dir ./data/ama-v4 \
  --output-dir ./runs/ama-v4 \
  --retrieval-profile fts5 \
  --skill picorer-v0 \
  --retrieval-agent-dir "$HOME/.pi/agent" \
  --answer-agent-dir "$HOME/.pi/agent" \
  --slots 16 \
  --stage-timeout-ms 1800000

npm run cli -- evaluate-benchmark \
  --benchmark ama-bench \
  --data-dir ./data/ama-v4 \
  --predictions ./runs/ama-v4/predictions.jsonl \
  --output ./runs/ama-v4/evaluation.json \
  --judge-agent-dir "$HOME/.pi/agent" \
  --slots 16 \
  --stage-timeout-ms 1800000
```

AMA-Bench evaluation is model-judged and therefore requires a configured Pi
judge runtime. The command above uses that agent directory's default model;
the independent `--judge-provider`, `--judge-model`, `--judge-thinking-level`,
and transport flags can pin another configured judge without exposing a
credential on the command line. Judge results are checkpointed per question;
a complete 2,496-question evaluation also emits the official episode-level
submission JSONL.

`--stage-timeout-ms` is an infrastructure deadline for each retrieval, answer,
or judge stage; it does not change model reasoning or benchmark semantics. The
30-minute Qwen recipe keeps `enable_thinking=true` while allowing a multi-turn
retrieval Agent to finish. Provider capacity should be controlled with
`--slots`, not by disabling thinking or shortening the official output budget.

### τ-Knowledge (τ-Banking)

This integration pins official `tau2-bench` revision
`a2c024725189473d2d7cea3a5cfdbcc67478e41f` (698 documents, 97 tasks).
Picorer verifies the exact document and task hashes, while the official runner
continues to own user simulation, banking tools, database state, checkpoints,
and task evaluation. The thin bridge translates only messages and tool schemas;
it never executes or evaluates a banking action itself.

```bash
git clone https://github.com/sierra-research/tau2-bench.git ./vendor/tau2-bench
git -C ./vendor/tau2-bench checkout a2c024725189473d2d7cea3a5cfdbcc67478e41f

npm run build
npm run cli -- ingest-tau-knowledge \
  --tau-root ./vendor/tau2-bench \
  --data-dir ./data/tau-knowledge \
  --retrieval-profile fts5

# Leaderboard-parity canary. OPENAI_API_KEY/OPENAI_API_BASE are consumed by the
# official runner for GPT-5.2 low user simulation. The Picorer variables point to
# the same protected credential without placing secrets on the command line.
uv run --frozen --project ./vendor/tau2-bench --extra knowledge -- \
  python ./integrations/tau-knowledge/run_tau_knowledge.py \
  --tau-root ./vendor/tau2-bench \
  --picorer-root "$PWD" \
  --data-dir ./data/tau-knowledge \
  --output-dir ./runs/tau-knowledge-picorer-canary \
  --condition picorer \
  --run-kind canary \
  --task-id task_001 \
  --skill picorer-v0 \
  --operator hybrid --operator lexical --operator chronological \
  --operator temporal-index --operator numeric-index \
  --agent-dir "$HOME/.pi/agent" \
  --provider picorer-openai-responses \
  --model gpt-5.4 \
  --thinking-level xhigh \
  --api-key-env PICORER_RETRIEVAL_API_KEY \
  --base-url-env PICORER_RETRIEVAL_BASE_URL \
  --transport sse \
  --slots 1
```

Add `--validate-only --allow-dirty` during local development to validate the
official runner registration and run configuration without making model calls
or creating result artifacts. Formal runs reject dirty Picorer and τ checkouts by
default.

The integration hard-codes the current official τ-Knowledge banking-domain recipe rather than
silently accepting a cheaper substitute: `tau2-bench` v1.0.1, `base` split,
GPT-5.4 with `xhigh` reasoning, GPT-5.2 with `low` reasoning as the user
simulator, temperature 0, seed 300, 200 maximum steps, and four trials over all
97 tasks. Canary runs keep both models and the seed fixed, reducing only the
task set and trial count. GPT-4o-mini is not a valid parity substitute.

Run the official AllTools calibration first. It uses the unmodified official
Agent scaffold with BM25, `text-embedding-3-large`, and sandboxed shell access:

```bash
uv run --frozen --project ./vendor/tau2-bench --extra knowledge -- \
  python ./integrations/tau-knowledge/run_tau_knowledge.py \
  --tau-root ./vendor/tau2-bench \
  --picorer-root "$PWD" \
  --data-dir ./data/tau-knowledge \
  --output-dir ./runs/tau-official-alltools \
  --condition official-alltools \
  --run-kind formal \
  --slots 3
```

Then run the two Picorer conditions with the exact same protected endpoints,
model, user simulator, task set, seed, trial count, limits, and concurrency:

```bash
for skill in none picorer-v0; do
  uv run --frozen --project ./vendor/tau2-bench --extra knowledge -- \
    python ./integrations/tau-knowledge/run_tau_knowledge.py \
    --tau-root ./vendor/tau2-bench \
    --picorer-root "$PWD" \
    --data-dir ./data/tau-knowledge \
    --output-dir "./runs/tau-picorer-${skill}" \
    --condition picorer \
    --run-kind formal \
    --skill "$skill" \
    --operator hybrid --operator lexical --operator chronological \
    --operator temporal-index --operator numeric-index \
    --agent-dir "$HOME/.pi/agent" \
    --provider picorer-openai-responses \
    --model gpt-5.4 \
    --thinking-level xhigh \
    --api-key-env PICORER_RETRIEVAL_API_KEY \
    --base-url-env PICORER_RETRIEVAL_BASE_URL \
    --transport sse \
    --slots 3
done
```

The formal experiment therefore has one leaderboard calibration and one clean
Picorer A/B. The AllTools score establishes that the model, user simulator, API,
official environment, and evaluator reproduce the expected difficulty. The
`none` versus `picorer-v0` comparison tests adaptive routing with the same Picorer
operator surface. Picorer remains a custom submission and must not be reported as
an official AllTools result.

For the operator-addition condition, pass a trusted local ESM module with
`--operator-module ./operators/my-operator.mjs`. It must export only the narrow
composition factory `createSearchOperators(store)` and return one or more
`SearchOperator` objects. The module executes as local code, is loaded once per
task process, and its path and SHA-256 are recorded in the run identity. The
registry still rejects duplicate IDs and freezes before the Agent starts; no
benchmark adapter, search tool, or Skill edit is needed.

The runner registers a custom, metadata-honest `picorer` retrieval condition:
the official prompt supplies no upstream knowledge-base tool, and Picorer alone
supplies search/read. Gold `required_documents`, evaluation criteria, and
initial-state annotations never enter the Picorer corpus or prompt. Runs are
marked custom submissions because the Agent scaffold and retrieval tools differ
from the paper's single-tool conditions. Use the same pinned checkout, user
simulator, model, seed, and trial count for `--skill none` versus
`--skill picorer-v0`; operator-addition experiments add only the corresponding
`--operator-module` while holding the built-in `--operator` set fixed.

AMA ingest stores sanitized memories, private questions, and private labels
separately. `benchmark` never loads `private/labels.jsonl`;
`evaluate-benchmark` reads it only after the frozen prediction file exists.
The pinned data identity is recorded in `dataset-manifest.json`, and model
outputs retain the same resumable `records/`, `predictions.jsonl`,
`traces.jsonl`, `failures.jsonl`, and `run-manifest.json` layout used by the
LongMemEval workflow. Evaluation manifests bind scores to the frozen
prediction file, source run, query set, label set, dataset track, code
fingerprint and judge identity. τ-Knowledge instead uses the official
`tau2-bench` result/checkpoint format plus a Picorer run manifest.

### MemoryArena Public

The [`integrations/memoryarena-public`](integrations/memoryarena-public/README.md)
integration runs the complete pinned public release: 701 task groups and 4,850
subtasks across shopping, progressive search, travel, math, and physics. The
official task agents, prompts, models, limits, environments, and evaluators stay
unchanged; Picorer replaces only the official memory HTTP service.

One task group is the recovery boundary. Timeout, 429, transient network, and
provider 5xx failures are retried in a fresh Picorer scope and remain pending on
exhaustion, so they never become a benchmark score of zero. The run directory
contains a concrete release-bound task manifest, accepted and retry trajectories,
raw Picorer traces, resumable judge-response cache, completeness gates, and
coverage-aware token/cost indexes. Formal runs require a clean, revision-locked
Picorer worktree and all 701 accepted task records before official scoring starts.

## Frozen selection replay

Use a frozen selection replay to measure answer-adapter reproducibility without
rerunning the stochastic retrieval Agent. The prepared input contains no gold
or original benchmark answer fields. `--include-selection-data` exports only
the Agent-selected citations, evidence, summary, count, and inventory; it does
not claim that experimental evidence packages exist.

```bash
python3 scripts/longmemeval_frozen_eval.py prepare-frozen-input \
  --results /path/to/run/results.json \
  --output /path/to/replay/input.json \
  --include-selection-data

# Load the protected answer environment before this command.
python3 scripts/longmemeval_frozen_eval.py reanswer \
  --input /path/to/replay/input.json \
  --output-dir /path/to/replay \
  --slots 32 \
  --mode selection-aware-v3
```

The replay manifest fixes the input hash, prompt hash, requested model, slot
count, and gold-visibility boundary. Existing durable per-question records are
resumed only when the configuration and search-result hashes still match.
## `bash_ro`

The shell is not the host shell. Each call starts a disposable container with:

- only the selected sanitized scope mounted at `/memory`, read-only;
- networking disabled;
- all Linux capabilities dropped;
- `no-new-privileges`;
- read-only root filesystem;
- CPU, memory, process, time and output limits.

Its purpose is source navigation (`grep`, `sed`, `awk`, `find`, small Python
scripts), especially when fixed retrieval misses a useful lexical or temporal
pattern.

## Development checks

```bash
npm run typecheck
npm test
npm run build
npm run test:python
# or run the complete release gate:
npm run check
```
