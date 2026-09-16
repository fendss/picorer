# Qwen 3.6 full benchmark question pipeline

## Why the previous run was paused

The old scheduler treated one benchmark stage as one queue job. Inside that
job, the adapter completed many questions concurrently and saved them under
`pending_by_query`, but the answer job could not start until the entire
retrieval process exited. It also rewrote and fsynced the growing suite JSON
after every question. This made progress reporting misleading and introduced a
full-dataset barrier between retrieval and answer.

The old run is paused at:

`/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911`

Its pre-migration backup is:

`/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/backups/pre-question-pipeline-20260911-070355`

## Runtime model

One row in `questions` is one benchmark question. The normalized
`question_stages` table records an independent retrieval, answer, and
evaluation status for that question. A successful stage writes one immutable
JSON artifact, commits its path and hash to SQLite, and immediately sends the
same question to the next Redis Stream.

SQLite is authoritative. Redis is only a wake-up transport. Duplicate messages
cannot duplicate model work because workers must atomically claim a `queued`
SQLite row. On restart, workers re-emit SQLite rows whose Redis notification may
have been lost.

The supervisor starts long-lived stage workers, applies answer-queue
backpressure to retrieval, restarts crashed workers, and stops them by process
group with a bounded grace period. A failed question blocks only its own later
stages.

Retrieval is retried automatically only for explicit safe Picorer failures such
as overload or `upstream_unavailable`. An ambiguous lost retrieval response is
kept as a failure because repeating a stochastic agent run would resample the
method. Answer transport failures may retry from the already persisted evidence
without repeating retrieval.

## Current prepared state

Code:

`/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2`

Prepared experiment:

`/data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911`

The prepared state is `state-v2.sqlite`. It contains 4,040 questions and has no
queued or running work. Prior compatible results were imported at a per-stage
boundary:

- 1,570 retrieval artifacts
- 1,181 answer artifacts
- 881 deterministic evaluation artifacts
- 300 answers waiting for an external judge
- 389 retrieved questions ready to enter answer without repeating retrieval

The full target is 4,211 questions. Before launch, 100 `infbench-sum` contexts
and 10 `detective-qa` contexts must be ingested. They cover the remaining 171
questions. All other existing ingestion checkpoints and BEAM or LoCoMo indexes
are reused.

BEAM uses the service run version in the public user ID. The frozen service
maps it to `beam_ingest_version`. LoCoMo follows the same rule with
`locomo_index_version`. Both identities are recorded in `omni-spec.json`.

## Preflight and launch

Run from the pipeline code directory:

```bash
cd /data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2
```

Audit missing AMB contexts without writing data:

```bash
.venv/bin/python -m question_pipeline.mab_prepare \
  --dry-run \
  --adapter-root /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/adapter-candidate \
  --config /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/amb/paper-main-missing4/config.yaml \
  --task infbench-sum --task detective-qa
```

Remove `--dry-run` to prepare only those missing contexts. Then build the full
manifest and update the prepared SQLite state without enqueueing any work:

```bash
.venv/bin/python -m question_pipeline.prepare_full \
  --experiment-root /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911 \
  --adapter-root /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/adapter-candidate \
  --mab-config /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/amb/core6/config.yaml \
  --mab-config /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/amb/large3/config.yaml \
  --mab-config /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/amb/lme300/config.yaml \
  --mab-config /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/amb/paper-main-missing4/config.yaml \
  --mab-source-results /data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/results/agentmemorybench \
  --omni-manifest /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/omni-manifest-v2.json
```

This command refuses to proceed unless it finds exactly 2,071 AMB questions
and 4,211 questions overall. Importing old AMB stage artifacts again is
idempotent.

Initialize Redis notifications only immediately before launch:

```bash
.venv/bin/python -m question_pipeline.cli \
  --state /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/state-v2.sqlite \
  --namespace picorer:qwen36:v100:question-pipeline:full \
  init --manifest /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/full-manifest.json
```

Use 16 retrieval and 4 answer slots for the current single Qwen deployment.
The answer pool is deliberately smaller because several EventQA evidence
packages approach the model context limit. A 16 plus 16 canary filled the KV
cache and starved retrieval; 16 plus 4 kept both stages moving. The larger
backlog threshold lets the 389 already-retrieved questions drain while new
retrieval starts, and then applies backpressure if answers fall behind:

```bash
.venv/bin/python -m question_pipeline.supervisor \
  --state /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/state-v2.sqlite \
  --namespace picorer:qwen36:v100:question-pipeline:full \
  --artifacts /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/artifacts-v2 \
  --logs /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/logs \
  --retrieval-concurrency 16 --answer-concurrency 4 \
  --evaluation-concurrency 4 --max-answer-backlog 512 \
  --stale-seconds 90 \
  --mab-export-dir /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/export/agentmemorybench \
  --omni-export-dir /data/zhaogangyi/picorer-eval/qwen36-v100-question-pipeline-20260911/export/omnimemeval
```

BEAM, LoCoMo, LongMemEval-S, and InfBench-Sum evaluation units stop at
`waiting_external` while judge funding is unavailable. Their retrieval and
answer artifacts remain complete and can be judged later without resampling.

## Validation

Thirteen unit and integration tests pass, and Ruff reports no findings.

A mixed 20-question canary exercised Fact-MH, Fact-SH, BEAM 100K, BEAM 10M,
LoCoMo, and the four largest saved EventQA evidence packages. With 16 retrieval
slots and 4 answer slots, all 20 retrievals and all 20 answers completed. Twelve
deterministic evaluations completed and eight LLM-judge evaluations stopped at
`waiting_external`. Retrieval median latency was 85.7 seconds and answer median
latency was 16.7 seconds.

The answer context safety reserve is 24,576 tokens. This compensates for the
difference between the fallback token estimator and Qwen's tokenizer while
preserving complete memory blocks. The previously failing Fact-MH case and the
788,015-character EventQA handoff both completed with the same saved evidence.

A BEAM 100K smoke test reused the existing index and completed retrieval in
44.9 seconds and answer in 20.5 seconds. Evaluation was immediately recorded as
`waiting_external`, as configured.
