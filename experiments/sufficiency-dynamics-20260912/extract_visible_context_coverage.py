#!/usr/bin/env python3
"""Audit exact gold statements visible in search previews at every saved state.

The existing coverage metric counts only exact passages returned by ``read``.
This audit scans the frozen request context and records gold statements that
are also visible in the current search preview.  Exact normalized substring
matching makes the preview count a conservative lower bound.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
from pathlib import Path

import pandas as pd


REMOTE_ROOTS = {
    "Run 1": "/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-20260912",
    "Run 2": "/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-replicate-2-20260912",
    "Run 3": "/data/zhaogangyi/picorer-eval/qwen36-v100-sufficiency-dynamics-replicate-3-20260912",
}

LOCAL_INPUTS = {
    "Run 1": "coverage/run1/state-replica.csv",
    "Run 2": "coverage/run2/state-replica.csv",
    "Run 3": "coverage/complete-run/state-replica.csv",
}


REMOTE_PROGRAM = r'''
import csv
import io
import json
import re
from pathlib import Path

roots = json.loads({roots_json!r})
spec_path = Path(roots["Run 3"]) / "coverage-v1/code/gold-spec.json"
spec = json.loads(spec_path.read_text(encoding="utf-8"))
gold = {{
    item["qa_pair_id"]: {{
        int(hop["hop_index"]): hop["normalized_statement"]
        for hop in item["gold_hops"]
    }}
    for item in spec["questions"]
}}

def normalize(value):
    return " ".join(str(value).casefold().strip().rstrip(".").split())

rows = []
for run, raw_root in roots.items():
    root = Path(raw_root)
    metadata = {{}}
    with (root / "coverage-v1/state-replica.csv").open(
        encoding="utf-8", newline=""
    ) as handle:
        for row in csv.DictReader(handle):
            key = (row["question_id"], int(row["decision_step"]))
            metadata[key] = row
    states = [
        json.loads(line)
        for line in (root / "decision-states-v2/index.jsonl").read_text(
            encoding="utf-8"
        ).splitlines()
        if line.strip()
    ]
    for state in states:
        question_id = state["question_id"]
        step = int(state["decision_step"])
        row = metadata[(question_id, step)]
        hops = gold[row["qa_pair_id"]]
        request = json.loads(
            (Path(state["capture_dir"]) / "request.body").read_text(
                encoding="utf-8"
            )
        )
        preview_parts = []
        read_parts = []
        tool_parts = []
        for message in request.get("messages", []):
            if message.get("role") != "tool":
                continue
            content = message.get("content") or ""
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            tool_parts.append(content)
            # A read tool message may concatenate READ_RESULT and MEMORY.
            # Match only the candidate sections, excluding working memory,
            # evidence receipts and the separately displayed read passages.
            for memory_block in re.findall(r"<MEMORY>(.*?)</MEMORY>", content, re.S):
                if "Latest uninspected findings" in memory_block:
                    preview_parts.append(memory_block.split("Latest uninspected findings", 1)[1])
                elif "Current search results" in memory_block:
                    preview_parts.append(memory_block.split("Current search results", 1)[1].split("Exact sources already read:", 1)[0])
            read_parts.extend(re.findall(r"<READ_RESULT>(.*?)</READ_RESULT>", content, re.S))
        preview_text = normalize("\n".join(preview_parts))
        read_text = normalize("\n".join(read_parts))
        tool_text = normalize("\n".join(tool_parts))
        rows.append(
            {{
                "round": run,
                "question_id": question_id,
                "decision_step": step,
                "current_preview_hop_indices": json.dumps(
                    [index for index, statement in hops.items() if statement in preview_text],
                    separators=(",", ":"),
                ),
                "current_read_result_hop_indices": json.dumps(
                    [index for index, statement in hops.items() if statement in read_text],
                    separators=(",", ":"),
                ),
                "current_tool_hop_indices": json.dumps(
                    [index for index, statement in hops.items() if statement in tool_text],
                    separators=(",", ":"),
                ),
            }}
        )

buffer = io.StringIO()
writer = csv.DictWriter(buffer, fieldnames=list(rows[0]))
writer.writeheader()
writer.writerows(rows)
print(buffer.getvalue(), end="")
'''


def parse_indices(value: str) -> set[int]:
    return {int(item) for item in json.loads(value)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-host", default="zgy-direct")
    parser.add_argument(
        "--experiment-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent
        / "analysis-rs-v2/three-rounds/visible-context-coverage.csv",
    )
    args = parser.parse_args()

    program = REMOTE_PROGRAM.format(
        roots_json=json.dumps(REMOTE_ROOTS, ensure_ascii=False)
    )
    completed = subprocess.run(
        ["ssh", args.ssh_host, "python3", "-"],
        input=program,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or "remote audit failed")
    preview = pd.read_csv(io.StringIO(completed.stdout))

    source_frames = []
    for run, relative in LOCAL_INPUTS.items():
        frame = pd.read_csv(args.experiment_dir / relative)
        frame = frame[frame["replica"] == "qwen-r1"].copy()
        frame["round"] = run
        source_frames.append(
            frame[
                [
                    "round",
                    "question_id",
                    "decision_step",
                    "gold_hop_count",
                    "covered_hop_indices",
                    "gold_coverage_r",
                ]
            ]
        )
    source = pd.concat(source_frames, ignore_index=True)
    merged = source.merge(
        preview,
        on=["round", "question_id", "decision_step"],
        how="inner",
        validate="one_to_one",
    ).sort_values(["round", "question_id", "decision_step"])
    if len(merged) != 2150:
        raise ValueError(f"expected 2,150 states, found {len(merged):,}")

    output_rows = []
    for (_, _), group in merged.groupby(["round", "question_id"], sort=False):
        cumulative_preview: set[int] = set()
        for row in group.sort_values("decision_step").itertuples(index=False):
            current_preview = parse_indices(row.current_preview_hop_indices)
            current_read_result = parse_indices(row.current_read_result_hop_indices)
            current_tool = parse_indices(row.current_tool_hop_indices)
            committed = parse_indices(row.covered_hop_indices)
            cumulative_preview.update(current_preview)
            visible_or_committed = committed | current_preview
            ever_seen_or_committed = committed | cumulative_preview
            output_rows.append(
                {
                    "round": row.round,
                    "question_id": row.question_id,
                    "decision_step": int(row.decision_step),
                    "gold_hop_count": int(row.gold_hop_count),
                    "committed_coverage_r": float(row.gold_coverage_r),
                    "current_preview_hop_indices": json.dumps(
                        sorted(current_preview), separators=(",", ":")
                    ),
                    "current_preview_gold_count": len(current_preview),
                    "current_preview_coverage": len(current_preview)
                    / int(row.gold_hop_count),
                    "current_read_result_hop_indices": json.dumps(
                        sorted(current_read_result), separators=(",", ":")
                    ),
                    "current_tool_hop_indices": json.dumps(
                        sorted(current_tool), separators=(",", ":")
                    ),
                    "visible_or_committed_hop_indices": json.dumps(
                        sorted(visible_or_committed), separators=(",", ":")
                    ),
                    "visible_or_committed_coverage": len(visible_or_committed)
                    / int(row.gold_hop_count),
                    "cumulative_preview_hop_indices": json.dumps(
                        sorted(cumulative_preview), separators=(",", ":")
                    ),
                    "ever_seen_or_committed_hop_indices": json.dumps(
                        sorted(ever_seen_or_committed), separators=(",", ":")
                    ),
                    "ever_seen_or_committed_coverage": len(ever_seen_or_committed)
                    / int(row.gold_hop_count),
                }
            )
    output = pd.DataFrame(output_rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(args.output, index=False, quoting=csv.QUOTE_MINIMAL)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "states": len(output),
                "states_with_current_gold_preview": int(
                    (output["current_preview_gold_count"] > 0).sum()
                ),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
