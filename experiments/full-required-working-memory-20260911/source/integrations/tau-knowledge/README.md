# τ-Knowledge integration

This directory connects Picorer to the pinned official `tau2-bench` runner. It
does not reimplement the benchmark.

## Ownership boundary

The official Python environment owns:

- task loading and user simulation;
- banking tools and database state;
- communication-protocol enforcement;
- checkpoints and end-state evaluation.

Picorer owns:

- the read-only 698-document corpus;
- registered search operators and exact reads;
- the Pi Agent reasoning loop and optional routing Skill;
- provenance and operator/plugin identities attached to assistant traces.

`required_documents`, initial-state annotations, and evaluation criteria never
cross the bridge. The custom `picorer` retrieval variant uses the official
`no_knowledge` prompt because Picorer supplies the only knowledge-retrieval tools.

## Files

- `picorer_tau_agent.py` implements the official `HalfDuplexAgent` interface and
  translates JSONL messages/tool schemas.
- `run_tau_knowledge.py` pins source identity, registers the custom agent and
  retrieval condition, creates the official `TextRunConfig`, and writes the run
  manifest before calling `run_domain`. It repeatedly invokes the official
  auto-resume path until every requested task/trial has an evaluated result.
- `result_integrity.py` verifies the exact `(task, trial, seed)` ledger and
  refuses to treat `infrastructure_error` placeholders as benchmark scores.
- `dist/tau-knowledge-bridge.js` is the built TypeScript process spawned once
  per task. It keeps one stateful Pi Agent session and delegates domain actions
  back to the Python environment.

See the repository root README for pinned checkout, ingest, validation, and run
commands.

## Controlled comparisons

The runner enforces the official τ-Knowledge banking-domain v1.0.1 recipe:

- all 97 tasks from the `base` split;
- GPT-5.4 with `xhigh` reasoning as the Agent;
- GPT-5.2 with `low` reasoning as the user simulator;
- temperature 0, seed 300, 200 maximum steps, and four trials;
- official `alltools` (BM25 + `text-embedding-3-large` + sandboxed shell) for
  the standard calibration condition.

`--run-kind canary` preserves the models, reasoning levels, seed, temperature,
and limits while allowing one trial over explicit task IDs. It is never a
leaderboard result. GPT-4o-mini is intentionally rejected by the recipe gate.

Run `--condition official-alltools` first to calibrate the official environment
and provider. Then hold the pinned τ checkout, task IDs, user simulator, model,
seed, trial count, concurrency, built-in operator set, and limits fixed across
the Picorer comparison.

The execution layer defaults to five upstream retries with 15-second backoff,
then up to six audited auto-resume rounds. Before each round, a bounded
credential-safe GPT-5.2 preflight pauses while the user-simulator channel is
unavailable, preventing a provider-wide outage from becoming many full-episode
retries. A formal result is published only
when `validity-report.json` proves all 388 task/trial pairs are unique,
evaluated, free of infrastructure failures, and actually report GPT-5.4 Agent
and GPT-5.2 user-simulator responses. The manifest records normalized provider
and embedding endpoints but never API keys. Picorer's per-input deadline is
900 seconds, followed by a separate 930-second bridge watchdog; both remain
below the official 1,800-second simulation timeout. These settings affect
recovery only, not tasks, prompts, tools, seeds, state evaluation, or rewards.
The interactive Picorer runtime itself permits 64 internal Agent turns and 128
internal tool calls per environment input. These are declared method-compute
budgets, not tau2 evaluator settings and not substitutes for the official
200-step environment limit. The bridge only transports and records those
budgets. Formal runs reject a dirty tau2 checkout, so tasks, runner semantics,
user simulator, environment tools, and evaluation remain pinned upstream.

`--resume-infra` is the only supported migration for an older schema-v2 run.
It requires the benchmark, dataset, recipe, model condition, τ source, and
Picorer source to match exactly. Concurrency may be reduced during recovery
because it is an infrastructure throttle rather than benchmark semantics; both
the inherited and requested slot counts are retained. The old manifest and
result hashes are retained
as `resume_provenance`; upstream tau2 then discards and reruns only the invalid
infrastructure placeholders. Valid trials are never recomputed or rewritten.

- Bare-tools control: `--skill none`
- Adaptive routing: `--skill picorer-v0`
- Operator addition: add one `--operator-module PATH` to both the intended
  treatment and any always-use/fixed-use control required by the experiment.

The `official-alltools` condition is a standard-scaffold calibration. Picorer
conditions are custom submissions, not reproductions of either AllTools or the
paper's single `KB_search` conditions. Report official success/pass metrics
together with search/read/action traces, token use, latency, and plugin hashes.
