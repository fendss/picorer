#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 EXPERIMENT_ROOT ACQUISITION_STATE ANSWER_CAPTURE_PORT RUN_TAG" >&2
  exit 2
fi

experiment_root=$1
acquisition_state=$2
answer_capture_port=$3
run_tag=$4

base=/data/zhaogangyi/picorer-eval
pipeline=$base/queue-infra/question-pipeline-v2
python_bin=$pipeline/.venv/bin/python
redis_url=redis://127.0.0.1:6380/0
first_root=$base/qwen36-v100-sufficiency-dynamics-20260912
tls_root=$first_root/runtime/scoring-tls
measurement_script=$experiment_root/bin/run_measurements_v2.py
scoring_script=$experiment_root/bin/prepare_scoring.py

mkdir -p "$experiment_root/logs" "$experiment_root/runtime"

while true; do
  acquisition_counts=$(
    "$python_bin" - "$acquisition_state" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    counts = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM question_stages "
            "WHERE stage = 'retrieval' GROUP BY status"
        ).fetchall()
    )
finally:
    connection.close()
print(json.dumps(counts, sort_keys=True))
if counts.get("failed", 0):
    raise SystemExit(3)
if counts.get("completed", 0) == 100 and not (
    counts.get("queued", 0) or counts.get("running", 0)
):
    raise SystemExit(0)
raise SystemExit(4)
PY
  ) && acquisition_ready=0 || acquisition_ready=$?
  printf '%s acquisition %s\n' "$(date --iso-8601=seconds)" "$acquisition_counts"
  if [[ $acquisition_ready -eq 0 ]]; then
    break
  fi
  if [[ $acquisition_ready -eq 3 ]]; then
    echo "acquisition failed; refusing to measure or score" >&2
    exit 3
  fi
  sleep 30
done

"$python_bin" "$measurement_script" \
  --experiment-root "$experiment_root" \
  --replica qwen-r1=http://172.16.200.114:18081 \
  --replica qwen-r2=http://172.16.200.114:18082 \
  --workers 6 \
  --samples 101 \
  >"$experiment_root/logs/measurement-v2.log" 2>&1 &
measurement_pid=$!
echo "$measurement_pid" >"$experiment_root/runtime/measurement-v2.pid"

if ss -ltn "sport = :$answer_capture_port" | grep -q LISTEN; then
  echo "answer capture port $answer_capture_port is already occupied" >&2
  kill -TERM "$measurement_pid" 2>/dev/null || true
  exit 5
fi
nohup python3 "$experiment_root/bin/capture_proxy.py" \
  --host 127.0.0.1 \
  --port "$answer_capture_port" \
  --upstream-host 127.0.0.1 \
  --upstream-port 18194 \
  --ca-bundle "$tls_root/ca-bundle.pem" \
  --server-cert "$tls_root/cert.pem" \
  --server-key "$tls_root/key.pem" \
  --capture-root "$experiment_root/answer-captures" \
  --timeout-seconds 1260 \
  >"$experiment_root/logs/answer-capture-proxy.log" 2>&1 </dev/null &
answer_capture_pid=$!
echo "$answer_capture_pid" >"$experiment_root/runtime/answer-capture-proxy.pid"

for _ in $(seq 1 30); do
  if curl --cacert "$tls_root/ca-bundle.pem" -fsS --max-time 3 \
    "https://127.0.0.1:$answer_capture_port/v1/models" >/dev/null; then
    break
  fi
  sleep 2
done
curl --cacert "$tls_root/ca-bundle.pem" -fsS --max-time 5 \
  "https://127.0.0.1:$answer_capture_port/v1/models" >/dev/null

scoring_state=$experiment_root/state-scoring.sqlite
if [[ ! -e $scoring_state ]]; then
  (
    cd "$pipeline"
    "$python_bin" "$scoring_script" \
      --source-manifest "$experiment_root/manifest-full.json" \
      --source-config "$experiment_root/config.yaml" \
      --scoring-config "$experiment_root/config-scoring.yaml" \
      --manifest "$experiment_root/manifest-scoring.json" \
      --state "$scoring_state" \
      --retrieval-artifacts "$experiment_root/artifacts-main" \
      --generation-base-url "https://127.0.0.1:$answer_capture_port/v1" \
      --ca-bundle "$tls_root/ca-bundle.pem"
  ) >"$experiment_root/logs/prepare-scoring.log" 2>&1
  chmod 600 "$experiment_root/config-scoring.yaml"
fi

mkdir -p \
  "$experiment_root/artifacts-scoring" \
  "$experiment_root/logs/pipeline-scoring" \
  "$experiment_root/export-scoring"

export MAB_ANSWER_FALLBACK_AUDIT="$experiment_root/logs/answer-fallback.jsonl"
"$python_bin" -m question_pipeline.supervisor \
  --state "$scoring_state" \
  --namespace "picorer:qwen36:v100:suffdyn:$run_tag:score" \
  --redis-url "$redis_url" \
  --artifacts "$experiment_root/artifacts-scoring" \
  --logs "$experiment_root/logs/pipeline-scoring" \
  --retrieval-concurrency 1 \
  --answer-concurrency 4 \
  --evaluation-concurrency 8 \
  --max-answer-backlog 128 \
  --stale-seconds 2100 \
  --grace-seconds 30 \
  --max-restarts 5 \
  --mab-export-dir "$experiment_root/export-scoring" \
  >"$experiment_root/logs/supervisor-scoring.log" 2>&1 &
scoring_pid=$!
echo "$scoring_pid" >"$experiment_root/runtime/supervisor-scoring.pid"

scoring_status=0
wait "$scoring_pid" || scoring_status=$?
measurement_status=0
wait "$measurement_pid" || measurement_status=$?

"$python_bin" - "$experiment_root" "$scoring_state" "$measurement_status" "$scoring_status" <<'PY'
import json
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
connection = sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True)
try:
    counts = [
        {"stage": stage, "status": status, "count": count}
        for stage, status, count in connection.execute(
            "SELECT stage, status, COUNT(*) FROM question_stages "
            "GROUP BY stage, status ORDER BY stage, status"
        )
    ]
finally:
    connection.close()
measurement = json.loads((root / "measurement-v2-summary.json").read_text())
final = {
    "schema_version": 1,
    "measurement_exit_code": int(sys.argv[3]),
    "scoring_exit_code": int(sys.argv[4]),
    "measurement": measurement,
    "scoring_counts": counts,
}
(root / "replicate-final.json").write_text(
    json.dumps(final, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(final, sort_keys=True))
if int(sys.argv[3]) or int(sys.argv[4]) or measurement["failed"]:
    raise SystemExit(1)
expected = {
    ("retrieval", "completed", 100),
    ("answer", "completed", 100),
    ("evaluation", "completed", 100),
}
if {(row["stage"], row["status"], row["count"]) for row in counts} != expected:
    raise SystemExit(1)
PY
