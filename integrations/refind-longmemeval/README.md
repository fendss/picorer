# ReFind LongMemEval-S comparison lane

This integration runs Picorer on the fixed 50-question LongMemEval-S sample used
by STITCH and ReFind. It does not copy ReFind's search implementation: Picorer
keeps its own Skill and registered search operators. The comparable controls
are the dataset sample, GPT-5-mini retrieval and answer models, and the
GPT-4.1-mini judge protocol (`temperature=0`, `top_p=0.9`).
GPT-5-mini's omitted/default reasoning effort is pinned to `medium` for both
retrieval and answer calls; `off` would send the unsupported value `none`.

The comparison uses the OpenAI-compatible Chat Completions transport. The
configured provider returns invalid encrypted reasoning state when its
Responses endpoint is continued after a tool call, while the same model and
reasoning effort complete the equivalent multi-turn Chat Completions request.
Picorer is capped at four search executions per question, matching ReFind's
reported maximum retrieval iterations. Reads and the final evidence selection
remain separate operations and do not consume that search budget.

The task manifest must pin:

- `xiaowu0162/longmemeval-cleaned` revision and file SHA-256;
- STITCH `paper-exp` commit, Python sampling implementation, and seed 42;
- all 50 ordered question IDs and their canonical hash.

`run_s50.sh` expects a pre-indexed, 50-question Picorer data directory. It uses
per-question benchmark records for resume. Provider capacity failures remain
pending: the supervisor waits for a successful full-budget health request and
then resumes missing questions. The exact ReFind judge has its own manifest,
prompt hash, response cache, and output directory; it never replaces Picorer's
native stricter evaluation artifacts.

For a single sampled run, do not retry model-behavior failures such as a run
timeout or failure to call `finish`. Use `materialize_scored_predictions.py` to
place them in the fixed 50-question denominator as empty answers. The helper
fails closed if a missing result is an infrastructure/provider failure, which
must be resumed instead of scored.

Required environment variables are documented by the script's startup checks.
Secrets stay in mode-`0600` env files and must not be copied into the run
manifest or repository.

For routine runs, copy `run_s50.example.yaml` outside the repository, edit the
paths, credentials, models, and concurrency in that single file, and set it to
mode `0600`. `run.max_search_calls` defaults to the ReFind-comparable budget of
`4`; larger values are diagnostic capability runs and must not be reported as
equal-budget ReFind comparisons. Validate without exposing credentials, then
run:

```bash
chmod 600 /secure/path/run_s50.yaml
node integrations/refind-longmemeval/run_s50_from_yaml.mjs \
  --check /secure/path/run_s50.yaml
node integrations/refind-longmemeval/run_s50_from_yaml.mjs \
  /secure/path/run_s50.yaml
```

The YAML launcher validates the evaluator-source schema before any paid model
call and passes secrets only through the child environment. It never
prints them or includes them in benchmark manifests. The older env-file inputs
remain supported for existing resumable runs.
