# MemoryArena Public integration boundary

This directory connects Picorer to the official public MemoryArena release without
vendoring or editing it. The code checkout, Hugging Face snapshots, task
selection, official configs, runners, and evaluators stay attributable to one
fixed upstream state. Generated configs and results live in a separate run
directory.

The integration does not contain benchmark task data and `bootstrap.py` does not
download it.

## Reproducibility pins

| Surface | Repository | Immutable revision |
| --- | --- | --- |
| Code | `ZexueHe/MemoryArena` | `6cd9de14b71915e39ac742a20dc33785e14b6aab` |
| Public tasks | `ZexueHe/memoryarena` | `da1a37c8b19280e18627ca01cf368195a5e1d92e` |
| Shopping product DB | `ai-hyz/MemoryArena-product-db` | `46120a5c931d04a47bd791965d757207b7372b62` |
| Search embeddings | `joanna690/websearch-embeddings` | `40b2422e641b46b903312c2e5b0c4ef9380f5352` |
| BrowseComp-Plus | `Tevatron/browsecomp-plus` | `144cff8e35b5eaef7e526346aa60774a9deb941f` |
| BrowseComp-Plus corpus | `Tevatron/browsecomp-plus-corpus` | `b27b02bc3e45511b8b82a13e6f90ce761df726f6` |
| BrowseComp-Plus qrels | `texttron/BrowseComp-Plus` | `046949032b0328319cc9a02663a759ec601d9402` |

`pins.json` is the machine-readable authority. The travel flight CSV linked by
the public setup guide has neither an immutable revision nor an upstream
checksum. It is therefore explicitly marked as an unversioned external asset,
not silently treated as pinned. A run wrapper must record the digest of the
local file it actually used.

## Bootstrap

Run this from the Picorer repository root. The checkout is intentionally placed
outside the repository, and the data revision is mandatory even though it is
also present in `pins.json`.

```bash
mkdir -p ../memoryarena-work
python3 integrations/memoryarena-public/bootstrap.py \
  --checkout-dir ../memoryarena-work/upstream \
  --run-dir ../memoryarena-work/run-001 \
  --data-revision da1a37c8b19280e18627ca01cf368195a5e1d92e
```

The bootstrap performs these checks before a run can proceed:

1. Clone without vendoring, or reuse an existing checkout only when its
   `origin` matches the official repository.
2. Fetch and detach at the exact code SHA; in `--offline` mode, require that SHA
   to be present already.
3. Require a clean Git worktree before and after config materialization.
4. Bind the explicit data revision to the fixed 701-task manifest.
5. Read tracked official configs without changing them and write five effective
   configs plus provenance sidecars under `<run-dir>/effective-configs/`.

The default Picorer gateway identity is `picorer` at
`http://127.0.0.1:3111`. `--memory-backend` and `--memory-url` may replace only
those transport fields. Every pure-infrastructure override must name exactly
one suite as `SUITE:DOTTED_PATH=URL`; an unscoped dotted path is rejected. For
example, the two official configs that otherwise point at port 8005 can be
routed to the official environment server on port 8001 without touching the
other three configs:

```bash
python3 integrations/memoryarena-public/bootstrap.py \
  --checkout-dir ../memoryarena-work/upstream \
  --run-dir ../memoryarena-work/run-001 \
  --data-revision da1a37c8b19280e18627ca01cf368195a5e1d92e \
  --infra-endpoint bundled_shopping:env.env_server_url=http://127.0.0.1:8001 \
  --infra-endpoint group_travel_planner:env.env_server_url=http://127.0.0.1:8001
```

The exact field boundary is documented in
[`config-boundary.md`](config-boundary.md). Model names, prompts,
temperatures, token/step limits, judge settings, evaluator logic, and task
content are not overrideable.

## Production workflow

The commands below are intended to be copied from a clean Picorer Git worktree.
Use an isolated Python environment containing the official requirements plus
`huggingface_hub`, `pyarrow`, and the Python packages imported by the five
official runners/evaluators. Node.js must satisfy the version in the root
`package.json`.

Choose paths outside both source trees. Do not place gateway state under the
Picorer worktree: production preparation rejects tracked changes and untracked
files and binds the full clean Picorer `HEAD` to the source run manifest.

```bash
export MA_PICORER_ROOT="$PWD"
export MA_INTEGRATION="$MA_PICORER_ROOT/integrations/memoryarena-public"
export MA_WORK="$MA_PICORER_ROOT/../memoryarena-work/run-001"
export MA_CHECKOUT="$MA_WORK/official-checkout"
export MA_SETUP="$MA_WORK/setup"
export MA_DATA="$MA_WORK/public-data"
export MA_SNAPSHOTS="$MA_WORK/hf-snapshots"
export MA_QRELS_CHECKOUT="$MA_WORK/browsecomp-plus-qrels"
export MA_RUN="$MA_WORK/runtime"
export MA_PROVIDER_PROXY="http://127.0.0.1:4100/v1"
export MA_RETRIEVAL_MODEL="gpt-5.4-mini"
export MA_EMBEDDING_MODEL="text-embedding-v4"
export PYTHONPATH="$MA_INTEGRATION"
export MA_ENV_FILE="$MA_WORK/memoryarena-public.env"
mkdir -p "$MA_SETUP" "$MA_DATA" "$MA_SNAPSHOTS"

python3 - <<'PY'
import os
import shlex
from pathlib import Path

names = (
    "MA_PICORER_ROOT", "MA_INTEGRATION", "MA_WORK", "MA_CHECKOUT", "MA_SETUP",
    "MA_DATA", "MA_SNAPSHOTS", "MA_QRELS_CHECKOUT", "MA_RUN",
    "MA_PROVIDER_PROXY", "MA_RETRIEVAL_MODEL", "MA_EMBEDDING_MODEL",
    "PYTHONPATH", "MA_ENV_FILE",
)
path = Path(os.environ["MA_ENV_FILE"])
path.write_text(
    "".join(f"export {name}={shlex.quote(os.environ[name])}\n" for name in names),
    encoding="utf-8",
)
path.chmod(0o600)
print(f"Wrote sourceable non-secret environment: {path}")
PY
```

The generated environment file is outside the Picorer worktree and deliberately
contains no API keys. At the start of **every additional shell**, open that
shell in the Picorer repository and restore the shared paths with:

```bash
export MA_PICORER_ROOT="$(git rev-parse --show-toplevel)"
source "$MA_PICORER_ROOT/../memoryarena-work/run-001/memoryarena-public.env"
```

Set the required API key separately in each process shell; do not add it to the
sourceable file.

`MA_PROVIDER_PROXY` is an external OpenAI-compatible, fail-closed metering
proxy. It must durably ledger every HTTP attempt (including timeouts and calls
whose response omits usage) and preserve `Retry-After`. It is not the Picorer
memory HTTP server. Both `OPENAI_BASE_URL` and the older `OPENAI_API_BASE` alias
are forced to this locked endpoint for official task workers.

### 1. Bootstrap and hydrate the pinned sources

Bootstrap the immutable official checkout before installing its untracked data
assets:

```bash
python3 "$MA_INTEGRATION/bootstrap.py" \
  --checkout-dir "$MA_CHECKOUT" \
  --run-dir "$MA_SETUP/bootstrap" \
  --data-revision da1a37c8b19280e18627ca01cf368195a5e1d92e \
  --infra-endpoint bundled_shopping:env.env_server_url=http://127.0.0.1:8001 \
  --infra-endpoint group_travel_planner:env.env_server_url=http://127.0.0.1:8001
```

Hydrate every Hugging Face source by immutable revision. The following uses
`local_dir` only as a byte source; the asset gate verifies each required Git
blob or LFS digest against `upstream/hf_source_manifests.json`.

```bash
python3 - <<'PY'
import os
from huggingface_hub import snapshot_download

root = os.environ["MA_SNAPSHOTS"]
sources = {
    "public": ("ZexueHe/memoryarena", "da1a37c8b19280e18627ca01cf368195a5e1d92e"),
    "shopping": ("ai-hyz/MemoryArena-product-db", "46120a5c931d04a47bd791965d757207b7372b62"),
    "websearch": ("joanna690/websearch-embeddings", "40b2422e641b46b903312c2e5b0c4ef9380f5352"),
    "browsecomp": ("Tevatron/browsecomp-plus", "144cff8e35b5eaef7e526346aa60774a9deb941f"),
    "corpus": ("Tevatron/browsecomp-plus-corpus", "b27b02bc3e45511b8b82a13e6f90ce761df726f6"),
}
for name, (repo_id, revision) in sources.items():
    snapshot_download(
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        local_dir=os.path.join(root, name),
    )
PY
```

The official search evaluator's qrel evidence comes from a separate pinned Git
repository. Hydration accepts only this clean exact checkout and verifies the
source blob before installing it into the MemoryArena checkout:

```bash
git clone https://github.com/texttron/BrowseComp-Plus.git "$MA_QRELS_CHECKOUT"
git -C "$MA_QRELS_CHECKOUT" fetch --depth 1 origin 046949032b0328319cc9a02663a759ec601d9402
git -C "$MA_QRELS_CHECKOUT" checkout --detach 046949032b0328319cc9a02663a759ec601d9402
test "$(git -C "$MA_QRELS_CHECKOUT" rev-parse HEAD)" = 046949032b0328319cc9a02663a759ec601d9402
test -z "$(git -C "$MA_QRELS_CHECKOUT" status --porcelain)"
```

The public release stores the five suite `data.jsonl` files directly as normal
Git blobs. Install those files and every auxiliary asset with the pin-aware
hydrator below. It verifies all four snapshot trees first, checks both SHA-256
and Git blob identity for the five public JSONL files, installs the exact
shopping/search files without overwriting different bytes, decrypts the pinned
BrowseComp-Plus parquet with the official XOR/canary transformation, and
exports the corpus shards in fixed order.

The travel CSV has no public checksum. Download it from the URL in `pins.json`
and supply its absolute local path explicitly; the command fails if it is
missing and records its actual SHA-256 without claiming an upstream pin.

```bash
export MA_TRAVEL_FLIGHTS_SOURCE="/absolute/path/to/clean_Flights_2022.csv"

python3 -B -m upstream.hydrate \
  --checkout "$MA_CHECKOUT" \
  --data-root "$MA_DATA" \
  --public-data-snapshot "$MA_SNAPSHOTS/public" \
  --shopping-product-snapshot "$MA_SNAPSHOTS/shopping" \
  --websearch-embeddings-snapshot "$MA_SNAPSHOTS/websearch" \
  --browsecomp-plus-snapshot "$MA_SNAPSHOTS/browsecomp" \
  --browsecomp-plus-corpus-snapshot "$MA_SNAPSHOTS/corpus" \
  --browsecomp-plus-qrels-checkout "$MA_QRELS_CHECKOUT" \
  --travel-flights-csv "$MA_TRAVEL_FLIGHTS_SOURCE" \
  --output "$MA_SETUP/hydration.lock.json"
```

The qrel install is mandatory. The hydrator verifies the pinned repository,
revision, source path, SHA-256, Git blob OID, and exact coverage of the 221
release queries before the local asset lock can be built.

Now prove the installed assets. This does not self-sign a revision: it checks
the fixed HF tree/blob identities, validates the derived ground-truth answer
payloads and corpus row order, and records the actual travel CSV hash.

```bash
python3 -B -m upstream.assets \
  --checkout "$MA_CHECKOUT" \
  --data-root "$MA_DATA" \
  --shopping-product-snapshot "$MA_SNAPSHOTS/shopping" \
  --websearch-embeddings-snapshot "$MA_SNAPSHOTS/websearch" \
  --browsecomp-plus-snapshot "$MA_SNAPSHOTS/browsecomp" \
  --browsecomp-plus-corpus-snapshot "$MA_SNAPSHOTS/corpus" \
  --output "$MA_SETUP/local-assets.lock.json"
```

### 2. Materialize the concrete release and source run manifest

The search join uses the 221 pinned BrowseComp runner IDs, not public row
ordinals `0..220`. Materialization fails unless all 701 concrete TaskSpecs,
4,850 ordered subtask IDs, source-record hashes, domain counts, data revision,
and auxiliary runner-ID provenance match exactly.

```bash
python3 -B -m upstream.manifest \
  --data-root "$MA_DATA" \
  --search-task-data "$MA_CHECKOUT/env/env_systems/web_search_env/data/browsecomp_all_jsons.jsonl" \
  --asset-lock "$MA_SETUP/local-assets.lock.json" \
  --output "$MA_SETUP/tasks.lock.json"

python3 -B -m upstream.prepare \
  --run-id "memoryarena-public-001" \
  --task-manifest "$MA_SETUP/tasks.lock.json" \
  --provider-proxy-url "$MA_PROVIDER_PROXY" \
  --retrieval-model "$MA_RETRIEVAL_MODEL" \
  --embedding-model "$MA_EMBEDDING_MODEL" \
  --picorer-root "$MA_PICORER_ROOT" \
  --config-dir "$MA_SETUP/bootstrap/effective-configs" \
  --output "$MA_SETUP/source-run.lock.json"
```

If a SHA-locked price table is used, add the same
`--price-table /absolute/path/prices.json` argument to preparation, task run,
resume, and evaluation. Without a bound table, USD cost remains unpriced; it is
never reported as zero.

### 3. Start the pinned official environment server

The pinned `env/env_server.py` is one shared official environment service and
listens on port 8001. The checked-in shopping and travel configs instead name
port 8005; the two suite-scoped bootstrap overrides above route only those
configs to 8001. Search and formal reasoning already use their own existing
8001 endpoint fields. The Picorer wrapper does not launch or patch this server.

Start it in a separate shell and keep it running for the task phase. Its
provider calls must use the same locked metering proxy:

```bash
export MA_PICORER_ROOT="$(git rev-parse --show-toplevel)"
source "$MA_PICORER_ROOT/../memoryarena-work/run-001/memoryarena-public.env"
export OPENAI_BASE_URL="$MA_PROVIDER_PROXY"
export OPENAI_API_BASE="$MA_PROVIDER_PROXY"
export HF_HUB_OFFLINE=1
export HF_DATASETS_OFFLINE=1
# Set the provider API key expected by the locked proxy in this shell.
cd "$MA_CHECKOUT"
python3 -B -m env.env_server
```

This starts the pinned file from the detached checkout; it does not edit the
official source. A deployment that deliberately keeps the 8005 config values
must instead provide an external 8005-to-8001 TCP bridge, but must not do both.

### 4. Start the dedicated Picorer memory gateway

Build Picorer, then start this command in a separate shell. The data directory is
dedicated to this run. The Python executor prefixes every official `user_id`
with the fresh task-attempt `memory_scope` and verifies the durable initialize,
add, and wrap lifecycle before accepting a result.

```bash
export MA_PICORER_ROOT="$(git rev-parse --show-toplevel)"
source "$MA_PICORER_ROOT/../memoryarena-work/run-001/memoryarena-public.env"
cd "$MA_PICORER_ROOT"
npm run build
export PICORER_DATA_DIR="$MA_WORK/picorer-data"
export HOST="127.0.0.1"
export PORT="3111"
export PICORER_MODEL="$MA_RETRIEVAL_MODEL"
export PICORER_LOGICAL_MODEL_ID="$MA_RETRIEVAL_MODEL"
export PICORER_RETRIEVAL_PROTOCOL="openai-completions"
export PICORER_SOURCE_IDENTITY="$(git rev-parse HEAD)"
export PICORER_BUILD_IDENTITY="$(git rev-parse HEAD)-production-build"
export PICORER_MAX_SEARCH_CALLS="4"
export PICORER_EMBEDDING_MODEL="$MA_EMBEDDING_MODEL"
export PICORER_AGENT_BASE_URL="$MA_PROVIDER_PROXY"
export OPENAI_API_BASE="$MA_PROVIDER_PROXY"
export OPENAI_BASE_URL="$MA_PROVIDER_PROXY"
# Also set OPENAI_API_KEY, PICORER_EMBEDDING_BASE_URL, and
# PICORER_EMBEDDING_API_KEY in this shell.
npm run serve:memoryarena-public
```

The source/build values and retrieval contract are exposed by `GET /runtime`
under a stable hash. The response also carries a separate persistent-store
identity created in `PICORER_DATA_DIR`; clients use that store identity for safe
ingestion reuse and the retrieval-contract hash for query resume. Formal
runners fail closed when either identity is missing or changes.

Each accepted attempt contains both the privacy-safe operation lifecycle and
`upstream/picorer-wrap-audits.jsonl`, which preserves the full Picorer retrieval
trajectory/evidence for that attempt. The executor checks the trajectory's
`retrieval_model.modelId` against the locked source run manifest. Gold answers
are used only by local integrity checks and are rejected from all Picorer HTTP
request bodies.

### 5. Run and resume all 701 task groups

In the runner shell, point at the already-running gateway and the same provider
proxy. No tracked official checkout code/config/evaluator file is modified; the
hydrator-installed untracked data assets are hash-gated on every task load.

```bash
export MA_PICORER_ROOT="$(git rev-parse --show-toplevel)"
source "$MA_PICORER_ROOT/../memoryarena-work/run-001/memoryarena-public.env"
export MEMORYARENA_PUBLIC_CHECKOUT="$MA_CHECKOUT"
export MEMORYARENA_PUBLIC_DATA_ROOT="$MA_DATA"
export MEMORYARENA_PUBLIC_TASK_MANIFEST="$MA_SETUP/tasks.lock.json"
export MEMORYARENA_PUBLIC_ASSET_LOCK="$MA_SETUP/local-assets.lock.json"
export MEMORYARENA_PUBLIC_CONFIG_DIR="$MA_SETUP/bootstrap/effective-configs"
export MEMORYARENA_PUBLIC_PROVIDER_PROXY_URL="$MA_PROVIDER_PROXY"
export MEMORYARENA_PICORER_ROOT="$MA_PICORER_ROOT"
export PICORER_DATA_DIR="$MA_WORK/picorer-data"
export OPENAI_BASE_URL="$MA_PROVIDER_PROXY"
export OPENAI_API_BASE="$MA_PROVIDER_PROXY"
# Set the provider API key expected by the locked proxy.

python3 -B "$MA_INTEGRATION/runtime/run_memoryarena_public.py" \
  --task-manifest "$MA_SETUP/tasks.lock.json" \
  --run-manifest "$MA_SETUP/source-run.lock.json" \
  --run-dir "$MA_RUN" \
  --executor upstream.executor:memoryarena_executor \
  --slots 1 \
  --attempts 3
```

Retryable 408/425/429/5xx/network failures, including silent official search
fallbacks detected from the Picorer lifecycle, fail the whole task group. A retry
gets a new attempt directory and memory scope. Resume with the same command and
frozen retry policy plus `--resume`:

```bash
python3 -B "$MA_INTEGRATION/runtime/run_memoryarena_public.py" \
  --task-manifest "$MA_SETUP/tasks.lock.json" \
  --run-manifest "$MA_SETUP/source-run.lock.json" \
  --run-dir "$MA_RUN" \
  --executor upstream.executor:memoryarena_executor \
  --slots 1 \
  --attempts 3 \
  --resume
```

Resume rejects changes to any Python/JSON file in the production executor
package, the official/data/task pins, provider proxy, price table, or the clean
Picorer Git identity.

### 6. Run and resume the five official evaluators

Evaluator input materialization first gates exactly 701 accepted production
records and 4,850 subtasks, validates their config/seam/raw-artifact provenance,
and only then stages official inputs. The qrel argument must resolve to the
exact file installed and verified by hydration; an arbitrary or absent qrel is
rejected.

```bash
export MA_PICORER_ROOT="$(git rev-parse --show-toplevel)"
source "$MA_PICORER_ROOT/../memoryarena-work/run-001/memoryarena-public.env"
export OPENAI_BASE_URL="$MA_PROVIDER_PROXY"
export OPENAI_API_BASE="$MA_PROVIDER_PROXY"
# Set the provider API key expected by the locked proxy in this shell.
export MA_EVAL_INPUT="$MA_WORK/evaluator-inputs"
export MA_EVAL_OUTPUT="$MA_WORK/evaluation"
export MA_SEARCH_QRELS="$MA_CHECKOUT/env/env_systems/web_search_env/data/qrel_evidence.txt"

python3 -B -m upstream.evaluator materialize \
  --run-dir "$MA_RUN" \
  --output-dir "$MA_EVAL_INPUT" \
  --checkout "$MA_CHECKOUT" \
  --asset-lock "$MA_SETUP/local-assets.lock.json" \
  --search-ground-truth "$MA_CHECKOUT/env/env_systems/web_search_env/data/browsecomp_plus_decrypted.jsonl" \
  --search-qrels "$MA_SEARCH_QRELS" \
  --shopping-product-catalog "$MA_CHECKOUT/data/shopping/product_catalog" \
  --shopping-domain-data "$MA_CHECKOUT/data/shopping/domain_data.json"

python3 -B -m upstream.evaluator run \
  --run-dir "$MA_RUN" \
  --input-dir "$MA_EVAL_INPUT" \
  --output-dir "$MA_EVAL_OUTPUT" \
  --checkout "$MA_CHECKOUT"
```

The second command is also the evaluator resume command. Re-run it unchanged
after timeout/425/429/5xx. Shopping always receives official `--force` so a partial
`reward_report.json` cannot cause a false skip. A wrapper-owned transport cache
replays every prior HTTP 2xx response byte-semantically, including responses
that the official parser rejects; only transport/425/429/5xx calls are retried.
Each invocation writes a new immutable `evaluation-attempts/judge-proxy-*.json`
ledger, and the final manifest indexes the response cache and regenerated
runtime artifact/usage indexes.

### Usage coverage and known gaps

No absent usage field is converted to zero:

- Picorer retrieval and embedding usage comes from durable operation audits;
  failure-terminal embedding deltas are retained as retry overhead. Missing
  provider usage is an explicit partial/unknown coverage gap.
- Search task-agent usage is captured from raw per-query files when emitted;
  travel exposes only its official aggregate usage file.
- The pinned shopping and formal runners do not expose task-agent usage, and
  shopping/search/formal inline environment judges omit some provider usage.
  Those surfaces remain `unknown` unless independently reconciled with the
  required external provider-proxy ledger.
- Final shopping/search evaluator judge calls are durably attributed, cached,
  and metered by the wrapper. Cache hits add no new cost. HTTP responses without
  usage and transport errors remain in the coverage denominator.

The official evaluator code, prompts, judge model defaults, retry loops,
thresholds, and aggregation are never patched. Travel/formal denominator bugs
are addressed only by the 701/4,850 completeness gate.

## Offline tests

The tests use temporary local Git repositories and never contact GitHub or
Hugging Face:

```bash
python3 -B -m unittest discover \
  -s integrations/memoryarena-public/tests \
  -p 'test_*.py'
```
