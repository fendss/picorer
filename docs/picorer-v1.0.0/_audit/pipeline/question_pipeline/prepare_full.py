from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .artifacts import atomic_json
from .combine_manifests import combine
from .mab_manifest import build as build_mab
from .mab_migrate import migrate
from .state import PipelineState


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare the complete 4211-question run without enqueueing it"
    )
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--adapter-root", type=Path, required=True)
    parser.add_argument("--mab-config", type=Path, action="append", required=True)
    parser.add_argument("--mab-source-results", type=Path, required=True)
    parser.add_argument("--omni-manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    root = args.experiment_root
    root.mkdir(parents=True, exist_ok=True)
    mab = build_mab(args.mab_config, args.adapter_root)
    if len(mab["questions"]) != 2071:
        raise ValueError(
            f"expected 2071 MemoryAgentBench questions, found {len(mab['questions'])}"
        )
    atomic_json(root / "mab-full-manifest.json", mab)
    omni = json.loads(args.omni_manifest.read_text())
    full = combine([mab, omni], expected=4211)
    atomic_json(root / "full-manifest.json", full)
    state_path = root / "state-v2.sqlite"
    artifacts = root / "artifacts-v2"
    imported = migrate(
        state_path, root / "mab-full-manifest.json", args.mab_source_results,
        artifacts, args.adapter_root,
    )
    state = PipelineState(state_path)
    inserted = state.initialize(full["questions"])
    report = {
        "status": "prepared_not_queued",
        "questions": len(full["questions"]),
        "benchmarks": dict(sorted(Counter(
            question["benchmark"] for question in full["questions"]
        ).items())),
        "new_questions": inserted,
        "imported_prior_stages": imported,
        "counts": state.counts(),
        "state": str(state_path),
        "manifest": str(root / "full-manifest.json"),
    }
    atomic_json(root / "PREFLIGHT-FULL.json", report)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

