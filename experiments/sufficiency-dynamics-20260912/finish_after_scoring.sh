#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 EXPERIMENT_ROOT SCORING_STATE" >&2
  exit 2
fi

experiment_root=$1
scoring_state=$2
base=/data/zhaogangyi/picorer-eval
python_bin=$base/queue-infra/question-pipeline-v2/.venv/bin/python

while true; do
  scoring_status=$(
    "$python_bin" - "$scoring_state" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    rows = list(
        connection.execute(
            "SELECT stage, status, COUNT(*) FROM question_stages "
            "GROUP BY stage, status ORDER BY stage, status"
        )
    )
finally:
    connection.close()
print(json.dumps(rows))
if any(status == "failed" for _, status, _ in rows):
    raise SystemExit(3)
expected = {
    ("retrieval", "completed", 100),
    ("answer", "completed", 100),
    ("evaluation", "completed", 100),
}
raise SystemExit(0 if set(rows) == expected else 4)
PY
  ) && scoring_ready=0 || scoring_ready=$?
  printf '%s scoring %s\n' "$(date --iso-8601=seconds)" "$scoring_status"
  if [[ $scoring_ready -eq 0 ]]; then
    break
  fi
  if [[ $scoring_ready -eq 3 ]]; then
    echo "scoring failed; refusing to hide the failure" >&2
    exit 3
  fi
  sleep 30
done

"$python_bin" "$experiment_root/bin/run_measurements_v2.py" \
  --experiment-root "$experiment_root" \
  --replica qwen-r1=http://172.16.200.114:18081 \
  --replica qwen-r2=http://172.16.200.114:18082 \
  --workers 8 \
  --samples 101 \
  >"$experiment_root/logs/measurement-v2.log" 2>&1 &
measurement_pid=$!
echo "$measurement_pid" >"$experiment_root/runtime/measurement-v2.pid"
wait "$measurement_pid"

"$python_bin" "$experiment_root/bin/audit_measurements_v2.py" \
  --experiment-root "$experiment_root" \
  --replica qwen-r1 \
  --replica qwen-r2 \
  --samples 101 \
  >"$experiment_root/logs/measurement-v2-audit.log" 2>&1

"$python_bin" - "$experiment_root" "$scoring_state" <<'PY'
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
audit = json.loads((root / "measurement-v2-audit.json").read_text())
final = {
    "schema_version": 2,
    "measurement_exit_code": 0,
    "scoring_exit_code": 0,
    "measurement": measurement,
    "measurement_audit": audit,
    "scoring_counts": counts,
}
(root / "replicate-final.json").write_text(
    json.dumps(final, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(final, sort_keys=True))
PY
