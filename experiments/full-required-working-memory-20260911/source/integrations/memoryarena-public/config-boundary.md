# MemoryArena Public configuration boundary

This boundary makes transport and artifact placement configurable while keeping
the benchmark definition fixed. The source of truth is the detached official
checkout at code revision `6cd9de14b71915e39ac742a20dc33785e14b6aab`.
The files under `overlays/` are small declarations; they are not copies of
upstream configs.

## Derivation rule

For each suite, `bootstrap.py` reads the tracked official base config as bytes,
records its SHA-256, deep-copies its JSON value, applies the fixed suite overlay,
and writes the effective config under the run directory. It then verifies that
the base bytes and the entire upstream Git worktree are unchanged.

Each effective config has a sidecar containing the code revision, explicit data
revision, base/overlay/manifest hashes, changed dotted paths, and expected task
range. The five sidecars and `bootstrap-manifest.json` are the config provenance
for a run.

## Allowed mutations

Only these dotted paths can differ from an official base config:

| Purpose | Allowed paths | Constraint |
| --- | --- | --- |
| Memory identity | `memory.memory_system_name` | Picorer defaults to the literal `picorer` |
| Memory transport | `memory.server_url`, `memory.memory_url`, `memory.base_url` | Credential-free HTTP(S) URL |
| Artifact placement | `output.output_dir`, `output.log_dir`, `output.global_csv`, `output.json_output_dir` | Must resolve inside the selected run directory |
| Agent transport | `agent.base_url` | Endpoint only; model and inference settings remain fixed |
| Environment transport | `env.base_url`, `env.env_server_url`, `env.mcp_url`, `env.env_config.base_url`, `env.env_config.upstream_env_server_base` | Endpoint/port routing only |
| Complete task selection | `task_specific.task_category`, `task_specific.task_file_limit`, `task_specific.query_ids` | Computed solely from the pinned public manifest |

The task-selection fields are not general user overrides. Bootstrap forces
shopping to `task_category="all"` with no positive file limit. For search, the
public dataset row IDs `0` through `220` are only stable task keys; the official
runner consumes 221 unrelated BrowseComp IDs. Bootstrap loads their exact
ordered mapping from the pinned `websearch-embeddings` auxiliary source and
binds its hash in the effective-config provenance. Travel and formal runners
load their full official test split; the formal dataset name/config/split are
checked against the manifest before writing the effective config.

The shipped overlay definition for every suite must contain exactly one memory
name, its suite-specific memory URL, and its official output fields. Arbitrary
or partial overlays are rejected. Infrastructure endpoint changes are supplied
separately through the explicitly suite-scoped form
`--infra-endpoint SUITE:DOTTED_PATH=URL`. The suite must be one of the five
manifest suite names, the dotted path must be allowlisted and already exist in
that suite's official config, and duplicate suite/path pairs are rejected. An
unscoped `DOTTED_PATH=URL` is never broadcast across heterogeneous configs and
is rejected as ambiguous.

For example, the single pinned `env/env_server.py` service listens on 8001,
while the shopping and travel configs name 8005. Production routes just those
two existing fields to the shared service:

```bash
--infra-endpoint bundled_shopping:env.env_server_url=http://127.0.0.1:8001 \
--infra-endpoint group_travel_planner:env.env_server_url=http://127.0.0.1:8001
```

Search and formal reasoning retain their existing 8001 endpoint fields. The
runtime wrapper does not start the official environment service; an operator
starts the detached checkout unchanged with
`python3 -B -m env.env_server` from the checkout root and keeps it running for
the task phase. Alternatively, a deployment may retain the 8005 config values
and provide an external 8005-to-8001 bridge, but it must not combine both
routing methods.

The production one-task executor makes one further run-scoped infrastructure
derivative under the attempt directory. It replaces every existing
`agent.base_url` and formal `env.env_config.base_url` with the credential-free
provider-proxy URL locked in the source run manifest, and replaces only the
suite's memory/output paths plus the single progressive-search runner ID. Both
`OPENAI_BASE_URL` and `OPENAI_API_BASE` are forced to that same endpoint. The
changed paths and all source/effective config hashes are recorded in
`attempt-config.provenance.json`; the bootstrapped source config and official
checkout remain unchanged.

## Forbidden mutations

Everything outside the allowlist is immutable. This explicitly includes:

- System/user/task prompts, agent instructions, backgrounds, answers, and all
  task payload content.
- Agent model, backend, provider, embedding model, temperature, token limits,
  context window, and iteration limits.
- Task/environment maximum steps or rounds, feedback/history behavior, resume
  semantics, and judgement mode.
- Judge model, judge prompt, `need_judge` behavior, evaluator selection,
  evaluator code, reward thresholds, aggregation, and denominators.
- Dataset repository/config/split, retrieval corpus/index paths, qrels, product
  catalog, flight data, or any task-file path.
- API keys and other credentials.

An official field missing from a chosen base config cannot be added merely
because a similarly named field is otherwise allowlisted.

## Complete public task manifest

The manifest is bound to `ZexueHe/memoryarena` revision
`da1a37c8b19280e18627ca01cf368195a5e1d92e` and must resolve to exactly 701
rows:

| Suite | HF config | IDs | Count | Official runner |
| --- | --- | ---: | ---: | --- |
| Bundled shopping | `bundled_shopping` | 0–149 | 150 | `run_shopping.py` |
| Progressive search | `progressive_search` | rows 0–220, mapped to pinned runner IDs | 221 | `run_search.py` |
| Group travel planner | `group_travel_planner` | 1–270 | 270 | `run_travel.py` |
| Formal reasoning, math | `formal_reasoning_math` | 0–39 | 40 | `run_math.py` |
| Formal reasoning, physics | `formal_reasoning_phys` | 0–19 | 20 | `run_math.py` |

Changing one count, range, split, HF config, runner binding, or selection mode
invalidates the manifest. Dataset hydration must pass the pinned revision
explicitly; the revision-less calls in upstream runners do not relax this
requirement.

## Official evaluator policy

The pinned evaluator surfaces are:

| Suite | Official evaluator surface |
| --- | --- |
| Bundled shopping | `env/env_systems/web_shopping_env/compute_reward.py` |
| Progressive search | `env/env_systems/web_search_env/evaluate_with_openai.py`, consumed by the official search environment/runner |
| Group travel planner | `env/env_systems/travel_planner_env/eval.py` |
| Formal reasoning, math and physics | `env/env_systems/formal_reasoning_env/eval.py` |

An external wrapper may schedule these entry points, capture their artifacts,
retry infrastructure failures, and reject incomplete coverage. It may not edit
or substitute evaluator/judge logic. Metrics are publishable only after the
wrapper confirms all expected task IDs and required per-task records exist.
The production evaluator performs that exact 701-task/4,850-subtask gate before
invoking any scorer and records every final-judge transport attempt plus its
ordered 2xx response replay cache. A normal 2xx parser failure remains official
evaluator semantics; it is not reclassified as an infrastructure failure.

## Memory HTTP contract that must remain exact

The official clients use this sequence per memory user/session:

1. `POST /memory/initialize` with
   `{"user_id":"...","memory_system_name":"picorer"}`. Success is
   `{"status":"ok","user_id":"...","memory_system_name":"picorer"}`.
   Repeating initialize for the same user replaces/resets that user's system.
2. For each query, `POST /memory/wrap_user_prompt` with
   `{"user_id":"...","memory_system_name":"picorer","question":"..."}`.
   Success contains `status`, `user_id`, and the string field `prompt`.
3. After the action/observation, `POST /memory/add` with
   `{"user_id":"...","memory_system_name":"picorer","chunk":"..."}`.
   Success is `{"status":"ok","user_id":"...","response":null}` when
   the backend returns Python `None`; JSON `null`, not the string `"None"`, is
   required.

With no stored memory, the wrapped prompt is exactly:

```text
<memory_context>
None
</memory_context>
User: {question}
```

An unknown user is HTTP 404 and a mismatched `memory_system_name` is HTTP 400.
There is no official close/delete/health/list route in this contract.

## Pinned-upstream issues and external workarounds

These are properties of the pinned public revision. They are documented and
handled outside the checkout; none justifies changing benchmark code or config
semantics.

| Upstream issue | Boundary-preserving handling |
| --- | --- |
| `env/env_server.py` listens on 8001, while shopping/travel docs and configs say 8005. | Start the unchanged module on 8001 and apply separate `bundled_shopping:env.env_server_url=...` and `group_travel_planner:env.env_server_url=...` overrides, or retain 8005 and bridge it externally. |
| `run_shopping.py` defaults to nonexistent `configs/web_shopping_configs/shopping_task.json`. | Always invoke it with the generated effective config. |
| Shopping setup says reward computation is automatic, but `run_shopping.py` does not invoke the standalone reward script. | Invoke the pinned `compute_reward.py` externally and retain its raw report. |
| `run_math.py` calls `main(json_config)` once and then again inside `try`; its automatic evaluator call is commented out. | The wrapper calls the official run function once, then invokes the pinned formal evaluator explicitly. |
| Public and auxiliary `load_dataset` calls omit `revision`. | Prehydrate/verify the pinned snapshots externally and run against that cache. |
| Travel evaluation iterates the intersection of ground-truth and submitted groups/persons. | Require all 270 group IDs and expected person records before accepting metrics. |
| Formal evaluation discovers only result directories/files that exist. | Require all 40 math or 20 physics papers and their expected query records first. |
| Search's checked-in config selects only runner query 116, the public row IDs are not runner IDs, and `store_eval_in_memory` is not consumed by `config_to_args`. | Expand only the exact 221 runner IDs joined from the pinned auxiliary task file; do not reinterpret unused behavioral fields. |
| `math_task.json` does not match the active `run_math.py` schema. | Use the pinned math/physics baseline configs named by the overlays. |
| Shopping setup names HF config `web_shopping`, but the code loads `bundled_shopping`. | Treat the code/data manifest binding `bundled_shopping` as authoritative. |
| `.gitmodules` and `memory/test_memory.py` contain stale MemActBench references. | Exclude stale upstream tests/dependencies from orchestration; do not repair them in place. |
| The travel flight CSV is distributed through an unversioned Google Drive folder. | Record the local file SHA-256 in run provenance and do not claim byte-reproducibility without a separately approved pin. |
