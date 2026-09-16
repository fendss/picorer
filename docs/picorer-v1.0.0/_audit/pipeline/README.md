# Picorer per-question evaluation pipeline

The unit of scheduling is one benchmark question. Retrieval completion writes
one immutable artifact and immediately releases that question to the answer
queue. Answer completion does the same for evaluation. A slow task or one long
question therefore cannot hold an entire benchmark stage behind a barrier.

SQLite is authoritative for payload identity, stage status, attempts, leases,
timings, and artifact hashes. Redis Streams only wakes workers. Duplicate Redis
messages are harmless because a worker must atomically claim a queued SQLite
row before doing work.

Large prompts and traces live in one JSON file per question and stage. SQLite
stores their path and hash. This removes the previous whole-suite JSON rewrite
after every question.

Typical commands:

```bash
python -m question_pipeline.mab_manifest \
  --config /path/to/config.yaml \
  --adapter-root /path/to/adapter-candidate \
  --eval-config config/eval.yaml \
  --output manifest.json

python -m question_pipeline.cli --state state.sqlite --namespace run:v2 \
  init --manifest manifest.json

python -m question_pipeline.cli --state state.sqlite --namespace run:v2 \
  worker --stage retrieval --artifacts artifacts --concurrency 16 \
  --max-downstream-backlog 64
```

`config/eval.yaml` is the source of truth for answer models, answer prompts,
and judge behavior by dataset. Model credentials are referenced by environment
variable name and are never stored in the YAML. Manifest generation validates
all model and prompt references, then stores the absolute config path, its
SHA-256, and the dataset key in every question. Workers reject later config
drift instead of silently mixing settings within one run. Manifests created
without `--eval-config` retain the legacy adapter behavior.

Validate the file before preparing a run:

```bash
python -m question_pipeline.eval_config config/eval.yaml
```

The judge `method` determines execution: `native` uses the benchmark's
deterministic scorer, `binary` runs a JSON CORRECT/WRONG judge, `longmemeval`
selects the official prompt by question type, and `beam` evaluates individual
rubric items with a separate event-ordering path. `infbench` runs the three
official fluency, recall, and precision judgments and computes HELMET-style
F1. `deferred` records that a judge contract is not ready and leaves the item
in `waiting_external`.

Run separate long-lived workers for retrieval, answer, and evaluation. With one
Qwen deployment, start with 16 retrieval slots and 4 answer slots; tune the
split from observed queue wait and endpoint saturation rather than increasing
both without a total capacity limit.

For the current full suite, prepare missing MemoryAgentBench contexts before
building its manifest. Existing ingestion checkpoints are reused and are never
reingested. Build BEAM with its recorded `beam_ingest_version` and LoCoMo with
its recorded `locomo_index_version`. The service-facing user ID keeps the
service run version, and the frozen service maps it to the recorded ingestion
version. Both values are explicit in the manifest so a mismatched service fails
before any benchmark result is silently attributed to the wrong corpus.

Combine manifests with an explicit coverage assertion:

```bash
python -m question_pipeline.combine_manifests \
  --input mab-manifest.json --input omni-manifest.json \
  --expected 4211 --output manifest.json
```

The supervisor starts all three worker pools, restarts a worker after a Redis
or process failure, stops automatically when no runnable stage remains, and
uses process-group termination with a bounded grace period.
