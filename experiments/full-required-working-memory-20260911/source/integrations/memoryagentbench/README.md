# Picorer × MemoryAgentBench

This is a standalone, black-box MemoryAgentBench adapter. It supports eleven Picorer
targets:

| Task ID | Official source | Capability | Official metric |
|---|---|---|---|
| `ruler-qa1` | `ruler_qa1_197K` | accurate retrieval | `substring_exact_match` |
| `longmemeval-s` | `longmemeval_s*` | accurate retrieval | GPT-4o LLM judge |
| `trec-coarse` | `icl_trec_coarse_6600shot_balance` | test-time learning | `exact_match` |
| `trec-fine` | `icl_trec_fine_6400shot_balance` | test-time learning | `exact_match` |
| `banking77` | `icl_banking77_5900shot_balance` | test-time learning | `exact_match` |
| `nlu` | `icl_nlu_8296shot_balance` | test-time learning | `exact_match` |
| `clinic150` | `icl_clinic150_7050shot_balance` | test-time learning | `exact_match` |
| `fact-sh-6k` | `factconsolidation_sh_6k` | conflict resolution | `substring_exact_match` |
| `fact-mh-6k` | `factconsolidation_mh_6k` | conflict resolution | `substring_exact_match` |
| `fact-mh-262k` | `factconsolidation_mh_262k` | conflict resolution | `substring_exact_match` |
| `eventqa-64k` | `eventqa_65536` | accurate retrieval | `substring_exact_match` |

## Boundary

The adapter does not import `src/`, `dist/`, Picorer packages, or the upstream
MemoryAgentBench checkout. Picorer is a separately started service and is reached
only through this HTTP lifecycle:

1. `POST /memory/initialize`
2. `POST /memory/add` for every ordered context chunk
3. `POST /memory/wrap_user_prompt` for every query

The wrapped prompt is sent to a separately configured OpenAI-compatible
`/chat/completions` endpoint. Ground-truth answers remain inside the adapter and
are used only after the model has returned its prediction.

Dataset files and outputs are ignored locally and are never committed. Official
code and dataset revisions, file sizes, and SHA-256 values are fixed in
`pins.json`. The upstream benchmark checkout is neither patched nor vendored.

Dependency direction:

```text
MemoryAgentBench data -> standalone adapter -> Picorer HTTP API
                                      `-----> answer-model HTTP API

Picorer core ---------------------------------> (no benchmark dependency)
```

## Setup

Run these commands from this directory. Python 3.10 or newer is supported.

### Linux/macOS

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m nltk.downloader punkt_tab
```

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m nltk.downloader punkt_tab
```

## Prepare and validate data

```bash
python run.py list
python run.py download --data-dir data
python run.py validate --data-dir data
```

The download is resolved from the pinned Hugging Face revision rather than
`main`. Validation fails closed on a changed hash, size, schema, source name,
context count, or question count.

## Start Picorer

Build and start Picorer from the repository root in another terminal. This uses
the already existing memory HTTP entrypoint; the adapter does not change it.

```bash
npm run build
PICORER_SOURCE_IDENTITY=git-commit-or-source-digest \
PICORER_BUILD_IDENTITY=deployed-build-digest \
PICORER_LOGICAL_MODEL_ID=gpt-5-mini \
PICORER_RETRIEVAL_PROTOCOL=openai-reasoning-completions \
PICORER_MAX_SEARCH_CALLS=4 \
PORT=3111 npm run serve:memoryarena-public
```

Configure Picorer's model and embedding provider using the environment variables
documented by the existing MemoryArena entrypoint. Wait for its `listening`
event before starting a benchmark run.

For server experiments, keep credentials, model roles, paths, service limits,
and run budgets in one mode-0600 YAML. The same file drives both processes:

```yaml
service:
  source_identity: git-9f87a1c-clean
  build_identity: sha256-of-the-deployed-build
```

Both values are required and must identify the exact deployed source/build;
they are not display labels.

Retrieval guidance and the harness presentation are independent settings. For
full operator-selection guidance with bounded candidate/read observations, use:

```yaml
service:
  skill: picorer-v0
  interface_mode: compact
```

Omitting `interface_mode` preserves compatibility: `picorer-minimal` defaults to
`compact`, while the other skills default to `full`. Both values are recorded
in the runtime identity.

For the Qdrant profile, pin its externally visible identity in the same
protected YAML instead of relying on ambient environment variables:

```yaml
service:
  retrieval_profile: picorer-hybrid-qdrant-hnsw-v1
  qdrant:
    url: http://127.0.0.1:6333
    collection: picorer_vectors_v1
    vector_generation_id: my-corpus-v1
    request_timeout_ms: 120000
    hnsw_m: 32
    ef_construct: 200
    hnsw_ef: 800
    full_scan_threshold_kb: 1000
    indexing_threshold_kb: 10000
    sync_batch_size: 512
    sync_concurrency: 4
    verification_poll_ms: 1000
    verification_timeout_ms: 3600000
    # api_key: optional-secret
```

The launcher derives the embedding profile from `paths.embedding_env`, passes
the pinned Qdrant settings to the service, and includes result-affecting index,
search, timeout, and fallback settings in the memory-index runtime identity
checked by both service and runner. Omitted fields use the defaults shown above;
ambient process values cannot override them.

```bash
node run_from_yaml.mjs --check /path/to/run.yaml
node run_from_yaml.mjs service /path/to/run.yaml
node run_from_yaml.mjs run /path/to/run.yaml static
node run_from_yaml.mjs suite /path/to/run.yaml
node run_from_yaml.mjs status /path/to/run.yaml
```

The sanitized check never prints the API key. `service` generates the Pi model
catalog under the configured runtime directory; `run` injects the same key and
base URL into the answer client, so no stale process environment is reused.
`suite` runs every configured `tasks × modes` combination with bounded
concurrency and resumes existing artifacts. Exit code 75 denotes a transient
remote outage; only that combination is requeued after
`run.retry_delay_seconds`. `status` reports artifact progress without exposing
credentials. `run.slots` bounds concurrent task/mode combinations, while
`run.context_slots` parallelizes ingestion and cumulative context lanes, and
`run.query_slots` parallelizes independent static/ephemeral questions. Queries
within one cumulative context remain ordered, preserving operator evolution.
When provider capacity is variable, `run.adaptive_query_slots` keeps
`query_slots` as the overall question-worker ceiling and applies independent
AIMD limits to retrieval wraps and answer requests:

```yaml
run:
  slots: 1
  query_slots: 64
  adaptive_query_slots:
    retrieval:
      minimum: 1
      initial: 8
      maximum: 16
      successes_per_increase: 8
    answer:
      minimum: 1
      initial: 16
      maximum: 48
      successes_per_increase: 8
```

A typed retryable infrastructure failure halves only that stage's current
limit; successes in one stage likewise cannot increase the other stage's
limit. An untyped answer-provider 408/429/5xx or transport outage is also an
answer-lane congestion signal, so that lane is reduced before the
already-persisted prompt is checkpointed for suite-level resume. It still never
enters the in-process retry loop. Method failures and untyped retrieval
ambiguity do not feed AIMD or trigger resampling. In-flight calls are allowed to finish.
The current limits, peak concurrency, success/failure counters, and every limit
change are stored as the two stages of schema v3 under
`execution.adaptive_query_concurrency`. Adaptive
mode requires `run.slots: 1` so task runners cannot create independent
controllers that oversubscribe the same provider. Keep each stage maximum no
larger than `query_slots`; setting the retrieval maximum above
`service.max_concurrent_wraps` only creates a local HTTP queue and does not add
retrieval capacity.

The former flat mapping remains supported and expands to two independent lanes
with identical policies:

```yaml
adaptive_query_slots:
  minimum: 1
  initial: 4
  successes_per_increase: 8
```

The service-side `service.max_concurrent_wraps` is the provider admission limit:
extra HTTP requests queue without starting extra retrieval agents. Exact wrap
retries share one in-flight/recent result, so a client timeout cannot duplicate
the underlying model call. `GET /health` exposes active/queued admission counts
and request-coalescing totals without prompts, memory, or credentials.
`GET /runtime` returns a hashed retrieval contract (source/build, skill hash,
provider route/model, budgets, request policy, and answer handoff) plus a
separate persistent-store identity.

## Smoke run

Set the API key for the answer endpoint, then execute one query:

```bash
export OPENAI_API_KEY=...
python run.py run \
  --task fact-sh-6k \
  --data-dir data \
  --output outputs/fact-sh-6k-smoke.json \
  --memory-base-url http://127.0.0.1:3111 \
  --answer-base-url https://api.openai.com/v1 \
  --answer-model gpt-4.1-mini \
  --max-contexts 1 \
  --max-queries 1
```

For a local OpenAI-compatible endpoint that does not require authentication,
the key may be omitted; the adapter then sends no `Authorization` header.

Remove the two limits for a full task run. Add `--resume` to preserve completed
predictions and continue after a process interruption. Completed context
ingestion is checkpointed and reused, so resume does not repeat successful
`initialize`/`add` calls. Resume fails
closed if the benchmark/data pins, task templates, exact retrieval runtime,
memory persistence instance, or answer endpoint/model differ from the saved
run. A non-retryable retrieval- or
answer-stage method failure is stored once as an empty prediction and remains
in the metric denominator; resume never resamples that question. A typed
retryable `upstream_unavailable`, `append_pending`, or HTTP 429 infrastructure
failure may instead preserve/retry a resumable boundary. Because ordinary
OpenAI-compatible answer endpoints do not emit Picorer retry headers, an untyped
answer HTTP 408/429/5xx or answer transport failure exits with code 75 after
persisting the exact pending prompt; `suite` then resumes that answer without
rerunning retrieval. The answer HTTP call itself is never retried. Untyped
retrieval transport ambiguity still fails closed because retrieval may have
changed method state. The effective request and recovery policies are locked
into the run artifact.

The same command works for every task listed by `python run.py list` by changing
`--task` and the output filename.

## Operator-evolution experiments

Every run fixes a search budget (four calls by default) and one operator mode:

```bash
python run.py run ... --operator-mode static --max-search-calls 4
python run.py run ... --operator-mode ephemeral --max-search-calls 4
python run.py run ... --operator-mode cumulative --max-search-calls 4
```

- `static` disables generated search operators.
- `ephemeral` may generate operators for the current question but starts the
  next question from a blank catalog.
- `cumulative` carries the returned operator-evolution snapshot to the next
  question in the same context. State never crosses a context boundary.

The output records the requested budget plus Picorer's reported search count and
operator audit for every question. A report that exceeds or changes the budget
is rejected. Query identities include the context ordinal because EventQA and
LongMemEval reuse `qa_pair_id` values across contexts.

Retrieval is checkpointed before the answer-model call. If the process is
interrupted between those stages, `--resume` reuses that exact wrapped prompt
and cumulative snapshot instead of re-ingesting memory or running
retrieval/evolution a second time. An answer endpoint failure is a completed
zero-score outcome, not a resumable chance to sample another answer. For later
queries in a partially completed context, the original ingestion timestamp is
also reused so resuming does not change the stored memory text.
Partial artifacts created before ingestion checkpoints were added are upgraded
on resume when a completed or pending query proves that its context was fully
ingested. A context with no such durable evidence is conservatively ingested
again.

`SIGTERM` and `SIGINT` request a graceful stop. The runner completes the
in-flight HTTP stage, atomically checkpoints its last reusable boundary, and
exits nonzero. If a termination signal overlaps an HTTP error, the question is
left pending rather than being incorrectly recorded as a zero-score method
failure. A second termination signal forces immediate interruption.

During ingestion, server-confirmed retryable `upstream_unavailable`,
`append_pending`, and HTTP 429 responses are retried without a fixed limit with
capped exponential backoff. Ambiguous transport failures stop the run, because
retrying a chunk after a lost success response could duplicate benchmark
memory. Retrieval time/turn/tool/protocol failures and empty completions are
final zero-score outcomes and can never be selected for retry by configuration.

`reuse_ingestion_from` is deliberately independent of the retrieval contract:
it requires the same memory URL, memory-system name, and persistent-store
identity. A new Skill or retrieval build may reuse proven ingestion on that
same store; a different service/database instance is rejected even if its
configuration text is identical.

## Results and evaluation

Every output records the immutable upstream revisions, task identity, model,
per-query prediction, private reference, local metrics, and aggregate metrics.
The run identity also includes the requested answer-handoff ID, the exact
handoff prompt-format version, and a SHA-256 of the answer system prompt. Resume
fails closed if any of these fields is absent or changes, before contacting
the model stages. The service echoes the same handoff version inside its hashed
runtime contract, and the adapter verifies the hash and handoff before the
first question.
Test-time-learning prompts require `label: {label}`; deterministic scoring
strips exactly that required prefix before applying the upstream exact-match
metric, while explanatory suffixes remain incorrect.
The `score` command recomputes deterministic metrics without contacting either
service:

```bash
python run.py score --input outputs/fact-sh-6k.json
```

For LongMemEval-S, `official_score` intentionally remains `null`: its official
metric is the upstream GPT-4o judge, not a locally invented substitute. The
output's `data` array contains the upstream-required `output` and `answer`
fields in official dataset order and can be staged for
`llm_based_eval/longmem_qa_evaluate.py` from the pinned benchmark commit.
The included official judge resume artifact is bound to the source artifact
SHA-256, exact prediction text/hash, GPT-4o model ID, and pinned prompt hash;
changed predictions are judged again instead of inheriting stale labels.

## Tests

```bash
python -B -m unittest discover -s tests -p 'test_*.py'
```

The tests are offline. They include a complete mock Picorer → wrapped prompt →
answer-model run and an isolation check that rejects imports from Picorer project
code.
