#!/usr/bin/env python3
"""Validate the frozen inputs and derived RQ2 analysis artifacts."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd
from PIL import Image


HERE = Path(__file__).resolve().parent
SUMMARY = HERE / "summary.json"
RESULTS = HERE / "results"
FIGURES = HERE / "figures"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(condition: bool, label: str, checks: list[dict[str, object]]) -> None:
    checks.append({"check": label, "passed": bool(condition)})
    if not condition:
        raise AssertionError(label)


def main() -> None:
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    checks: list[dict[str, object]] = []

    inputs = summary["inputs"]
    units_path = Path(inputs["units"])
    status_path = Path(inputs["status"])
    check(sha256(units_path) == inputs["units_sha256"], "units input hash matches", checks)
    check(sha256(status_path) == inputs["status_sha256"], "status input hash matches", checks)
    check(
        sha256(Path(inputs["answer_predictiveness"])) == inputs["answer_predictiveness_sha256"],
        "answer-predictiveness input hash matches",
        checks,
    )
    for run, record in inputs["state_package_files"].items():
        check(
            sha256(Path(record["path"])) == record["sha256"],
            f"run {run} state-package input hash matches",
            checks,
        )

    status = json.loads(status_path.read_text(encoding="utf-8"))
    check(
        status["expected_jobs"] == status["completed_jobs"] == 34126
        and status["missing_jobs"] == 0,
        "all 34,126 inference jobs complete",
        checks,
    )
    units = pd.read_csv(units_path)
    check(len(units) == 10018 and units["complete"].all(), "all 10,018 units complete", checks)
    check(units["native_n"].eq(2).all(), "two native logit reads per unit", checks)
    check(
        units.loc[units["experiment"].isin(["coverage", "state_answers"]), "answer_n"].eq(5).all(),
        "five package-fixed answers per analyzed unit",
        checks,
    )

    required_csv = [
        "controlled-effects.csv",
        "specificity.csv",
        "natural-transitions.csv",
        "natural-states-with-packages.csv",
        "trajectory-onsets.csv",
        "onset-categories.csv",
        "event-aligned-summary.csv",
        "threshold-sensitivity.csv",
        "hop-stratified.csv",
        "full100-sensitivity.csv",
        "transition-regression.csv",
        "answer-predictiveness.csv",
        "evidence-sufficiency-coupling.csv",
    ]
    for name in required_csv:
        frame = pd.read_csv(RESULTS / name)
        check(len(frame) > 0, f"{name} is present and nonempty", checks)

    primary = summary["primary_sample"]
    transitions = pd.read_csv(RESULTS / "natural-transitions.csv")
    all_states = pd.read_csv(RESULTS / "natural-states-with-packages.csv")
    states = all_states.loc[~all_states["conflicted"]].copy()
    pairs = pd.read_csv(RESULTS / "controlled-support-pairs.csv")
    check(all_states["question_id"].nunique() == 100, "state export retains all 100 questions", checks)
    check(states["question_id"].nunique() == primary["questions"] == 64, "primary sample has 64 questions", checks)
    check(states.groupby(["question_id", "run"]).ngroups == primary["trajectories"] == 192, "primary sample has 192 trajectories", checks)
    check(len(states) == primary["states"] == 1181, "primary sample has 1,181 states", checks)
    check(len(transitions) == primary["transitions"] == 989, "primary sample has 989 transitions", checks)
    check(int(transitions["support_gain"].sum()) == primary["support_gain_transitions"] == 287, "287 transitions gain gold support", checks)
    check(len(pairs) == primary["controlled_pairs"] == 1072, "1,072 controlled support-addition pairs", checks)

    event = pd.read_csv(RESULTS / "event-aligned-summary.csv")
    likelihood = event.loc[event["metric"].eq("sufficiency_likelihood")].set_index("offset")
    check(likelihood.index.tolist() == [-2, -1, 0, 1, 2], "event figure uses only observed integer offsets", checks)
    check(likelihood["questions"].astype(int).tolist() == [57, 57, 57, 17, 13], "event-point question counts match figure", checks)

    regression = pd.read_csv(RESULTS / "transition-regression.csv")
    check(regression["transitions"].eq(381).all(), "transition regression uses 381 package-changing transitions", checks)
    adjusted_margin = regression.loc[
        regression["model"].eq("Adjusted") & regression["term"].eq("delta_margin")
    ].iloc[0]
    check(adjusted_margin["ci_low"] > 0, "adjusted margin-change coefficient remains positive", checks)

    for stem in ["sufficiency-around-evidence-completion", "native-margin-around-evidence-completion"]:
        png = FIGURES / f"{stem}.png"
        pdf = FIGURES / f"{stem}.pdf"
        with Image.open(png) as image:
            check(image.size == (2820, 1950), f"{stem} PNG is 600-dpi export size", checks)
        pdf_bytes = pdf.read_bytes()
        check(b"TimesNewRomanPSMT" in pdf_bytes, f"{stem} PDF embeds Times New Roman", checks)
        check(len(pdf_bytes) > 10_000, f"{stem} PDF is nonempty", checks)

    output = {
        "status": "passed",
        "checks_passed": len(checks),
        "checks": checks,
        "input_hashes_frozen": True,
        "analysis_unit": "question",
        "bootstrap_draws": 5000,
        "bootstrap_seed_family": 20260915,
    }
    (HERE / "validation.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"PASS: {len(checks)} checks")


if __name__ == "__main__":
    main()
