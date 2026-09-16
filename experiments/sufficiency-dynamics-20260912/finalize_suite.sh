#!/usr/bin/env bash
set -euo pipefail

base=/data/zhaogangyi/picorer-eval
first=$base/qwen36-v100-sufficiency-dynamics-20260912
replicate_2=$base/qwen36-v100-sufficiency-dynamics-replicate-2-20260912
replicate_3=$base/qwen36-v100-sufficiency-dynamics-replicate-3-20260912
python_bin=$base/queue-infra/question-pipeline-v2/.venv/bin/python

"$python_bin" "$first/bin/run_measurements_v2.py" \
  --experiment-root "$first" \
  --replica qwen-r1=http://172.16.200.114:18081 \
  --replica qwen-r2=http://172.16.200.114:18082 \
  --workers 8 \
  --samples 101 \
  >"$first/logs/measurement-v2.log" 2>&1 &
first_measurement_pid=$!
echo "$first_measurement_pid" >"$first/runtime/measurement-v2.pid"
wait "$first_measurement_pid"

"$python_bin" "$first/bin/audit_measurements_v2.py" \
  --experiment-root "$first" \
  --replica qwen-r1 \
  --replica qwen-r2 \
  --samples 101 \
  >"$first/logs/measurement-v2-audit.log" 2>&1

for root in "$replicate_2" "$replicate_3"; do
  while [[ ! -f $root/replicate-final.json ]]; do
    printf '%s waiting for %s\n' "$(date --iso-8601=seconds)" "$root/replicate-final.json"
    sleep 60
  done
  "$python_bin" "$root/bin/audit_measurements_v2.py" \
    --experiment-root "$root" \
    --replica qwen-r1 \
    --replica qwen-r2 \
    --samples 101 \
    >"$root/logs/measurement-v2-audit.log" 2>&1
done

"$python_bin" - "$first" "$replicate_2" "$replicate_3" <<'PY'
import json
import sys
from pathlib import Path

roots = [Path(value) for value in sys.argv[1:]]
records = []
for trajectory_index, root in enumerate(roots, start=1):
    audit = json.loads((root / "measurement-v2-audit.json").read_text())
    record = {
        "trajectory_replicate": trajectory_index,
        "root": str(root),
        "question_count": audit["question_count"],
        "decision_state_count": audit["decision_state_count"],
        "measurement_count": audit["checked_result_count"],
        "explicit_label_count": audit["total_explicit_labels_checked"],
        "measurement_audit_failures": audit["failure_count"],
    }
    if trajectory_index == 1:
        record["answer_evaluation"] = "previously completed"
    else:
        final = json.loads((root / "replicate-final.json").read_text())
        record["scoring_counts"] = final["scoring_counts"]
    records.append(record)
suite = {
    "schema_version": 1,
    "protocol": "explicit-j-native-s-v2",
    "trajectory_replicates": records,
    "total_questions": sum(record["question_count"] for record in records),
    "total_decision_states": sum(
        record["decision_state_count"] for record in records
    ),
    "total_state_replica_measurements": sum(
        record["measurement_count"] for record in records
    ),
    "total_explicit_labels": sum(
        record["explicit_label_count"] for record in records
    ),
}
(roots[0] / "suite-final.json").write_text(
    json.dumps(suite, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(suite, indent=2, sort_keys=True))
PY
