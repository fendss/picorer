#!/usr/bin/env python3
"""Offline evidence--sufficiency dynamics analysis for Picorer RQ2.

Primary unit of inference: FactConsolidation-MH question. Repeated runs,
states, evidence combinations, model replicas, and answer samples stay within
their question during aggregation and bootstrap resampling.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Callable

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import statsmodels.api as sm


HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[1]
INTERVENTION_ROOT = WORKSPACE / "experiments" / "sufficiency-interventions-20260914"
DYNAMICS_ROOT = WORKSPACE / "experiments" / "sufficiency-dynamics-20260912"
UNITS_PATH = INTERVENTION_ROOT / "summary" / "units.csv"
STATUS_PATH = INTERVENTION_ROOT / "summary" / "status.json"
ANSWER_CV_PATH = INTERVENTION_ROOT / "analysis" / "unconflicted-heldout-metrics.csv"
STATE_FILES = {
    1: DYNAMICS_ROOT / "coverage" / "run1" / "states.jsonl",
    2: DYNAMICS_ROOT / "coverage" / "run2" / "states.jsonl",
    3: DYNAMICS_ROOT / "coverage" / "complete-run" / "states.jsonl",
}
RESULTS = HERE / "results"
FIGURES = HERE / "figures"
SKILL = Path.home() / ".codex" / "skills" / "scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from figure_export import export_figure
from palette_audit import audit_palette


SEED = 20260915
BOOTSTRAP_DRAWS = 5000
RED = "#B21F32"
BLUE = "#245C7C"
GRAY = "#666666"
CATEGORY_ORDER = [
    "S before R",
    "S and R together",
    "R before S",
    "S observed; R not observed",
    "R observed; S not observed",
    "Neither observed",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mean_ci(values: pd.Series | np.ndarray, seed_offset: int = 0) -> tuple[float, float, float]:
    array = np.asarray(values, dtype=float)
    array = array[np.isfinite(array)]
    if not len(array):
        return math.nan, math.nan, math.nan
    rng = np.random.default_rng(SEED + seed_offset)
    draws = rng.choice(array, size=(BOOTSTRAP_DRAWS, len(array)), replace=True).mean(axis=1)
    low, high = np.percentile(draws, [2.5, 97.5])
    return float(array.mean()), float(low), float(high)


def load_inputs() -> tuple[pd.DataFrame, pd.DataFrame]:
    status = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    assert status["expected_jobs"] == status["completed_jobs"] == 34126
    assert status["missing_jobs"] == 0

    units = pd.read_csv(UNITS_PATH)
    assert len(units) == 10018 and units["complete"].all()
    assert units["native_n"].eq(2).all()
    assert units.loc[units["experiment"].isin(["coverage", "state_answers"]), "answer_n"].eq(5).all()
    assert units["question_id"].nunique() == 100
    assert np.allclose(units["likelihood"], 1 / (1 + np.exp(-units["margin"])))

    package_rows: list[dict[str, object]] = []
    for run, path in STATE_FILES.items():
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            package_rows.append({
                "question_id": row["question_id"],
                "run": run,
                "step": row["decision_step"],
                "package_ids": tuple(row["cumulative_read_memory_ids"]),
                "action": json.dumps(row["action_tool_names"], separators=(",", ":")),
            })
    packages = pd.DataFrame(package_rows)
    assert len(packages) == 2150
    assert not packages.duplicated(["question_id", "run", "step"]).any()

    natural = units.loc[units["experiment"].eq("state_answers")].copy()
    natural["run"] = natural["run"].astype(int)
    natural["step"] = natural["step"].astype(int)
    natural["trajectory_length"] = natural["trajectory_length"].astype(int)
    natural = natural.merge(
        packages, on=["question_id", "run", "step"], how="left", validate="one_to_one"
    ).sort_values(["question_id", "run", "step"]).reset_index(drop=True)
    assert len(natural) == 2150 and natural["package_ids"].notna().all()
    assert natural.groupby(["question_id", "run"]).size().eq(
        natural.groupby(["question_id", "run"])["trajectory_length"].first()
    ).all()
    return units, natural


def build_transitions(natural: pd.DataFrame) -> pd.DataFrame:
    natural = natural.copy()
    groups = natural.groupby(["question_id", "run"], sort=False)
    natural["previous_margin"] = groups["margin"].shift()
    natural["previous_r"] = groups["r"].shift()
    natural["previous_package_ids"] = groups["package_ids"].shift()
    natural["previous_action"] = groups["action"].shift()
    natural["delta_margin"] = natural["margin"] - natural["previous_margin"]
    natural["delta_r"] = natural["r"] - natural["previous_r"]
    natural["normalized_progress"] = (
        (natural["step"] - 1) / (natural["trajectory_length"] - 1)
    )
    transitions = natural.loc[natural["previous_margin"].notna()].copy()
    transitions["package_changed"] = (
        transitions["package_ids"] != transitions["previous_package_ids"]
    )
    transitions["support_gain"] = transitions["delta_r"].gt(1e-12)
    transitions["sufficiency_rise"] = transitions["delta_margin"].gt(0)
    assert transitions["delta_r"].ge(-1e-12).all()
    assert transitions.loc[transitions["support_gain"], "package_changed"].all()
    for row in transitions.itertuples(index=False):
        assert set(row.previous_package_ids).issubset(set(row.package_ids))
    return transitions


def controlled_pairs(units: pd.DataFrame, include_conflicts: bool = False) -> pd.DataFrame:
    coverage = units.loc[units["experiment"].eq("coverage")].copy()
    if not include_conflicts:
        coverage = coverage.loc[~coverage["conflicted"]]
        assert len(coverage) == 760 and coverage["question_id"].nunique() == 64
    records: list[dict[str, object]] = []
    for (question_id, order), group in coverage.groupby(["question_id", "order"], sort=True):
        by_mask = {int(row["mask"]): row for row in group.to_dict("records")}
        hops = int(group.iloc[0]["gold_hops"])
        assert len(by_mask) == 2 ** hops
        for mask, before in by_mask.items():
            for bit in range(hops):
                if mask & (1 << bit):
                    continue
                after = by_mask[mask | (1 << bit)]
                records.append({
                    "question_id": question_id,
                    "order": int(order),
                    "gold_hops": hops,
                    "before_mask": mask,
                    "added_hop": bit + 1,
                    "final_missing_hop": bool(np.isclose(after["r"], 1)),
                    "before_r": before["r"],
                    "after_r": after["r"],
                    "delta_margin": after["margin"] - before["margin"],
                    "delta_likelihood": after["likelihood"] - before["likelihood"],
                    "delta_answer_accuracy": after["official_score"] - before["official_score"],
                    "delta_exact_match": after["exact_match"] - before["exact_match"],
                    "delta_input_tokens": after["input_tokens"] - before["input_tokens"],
                })
    pairs = pd.DataFrame(records)
    if not include_conflicts:
        assert len(pairs) == 1072
    return pairs


def summarize_controlled(pairs: pd.DataFrame, sample: str) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    subsets = {
        "Any missing gold fact added": pairs,
        "Last missing gold fact added": pairs.loc[pairs["final_missing_hop"]],
    }
    metrics = [
        ("Native sufficiency margin", "delta_margin"),
        ("Sufficiency likelihood", "delta_likelihood"),
        ("Answer accuracy", "delta_answer_accuracy"),
        ("Strict exact match", "delta_exact_match"),
        ("Input tokens", "delta_input_tokens"),
    ]
    for comparison, frame in subsets.items():
        question_means = frame.groupby("question_id")[[column for _, column in metrics]].mean()
        for offset, (metric, column) in enumerate(metrics):
            estimate, low, high = mean_ci(question_means[column], 100 + offset)
            rows.append({
                "sample": sample,
                "analysis": comparison,
                "metric": metric,
                "estimate": estimate,
                "ci_low": low,
                "ci_high": high,
                "questions": len(question_means),
                "pairs": len(frame),
            })
    return pd.DataFrame(rows)


def question_conditional(
    transitions: pd.DataFrame,
    denominator: Callable[[pd.DataFrame], pd.Series],
    outcome: Callable[[pd.DataFrame], pd.Series],
    seed_offset: int,
) -> dict[str, object]:
    values = []
    denominator_transitions = 0
    for question_id, group in transitions.groupby("question_id", sort=True):
        mask = denominator(group).astype(bool)
        denominator_transitions += int(mask.sum())
        if mask.any():
            values.append({"question_id": question_id, "value": float(outcome(group)[mask].mean())})
    frame = pd.DataFrame(values)
    estimate, low, high = mean_ci(frame["value"], seed_offset)
    return {
        "estimate": estimate,
        "ci_low": low,
        "ci_high": high,
        "eligible_questions": len(frame),
        "denominator_transitions": denominator_transitions,
    }


def question_mean_delta(
    transitions: pd.DataFrame,
    mask_function: Callable[[pd.DataFrame], pd.Series],
    seed_offset: int,
) -> dict[str, object]:
    values = []
    transitions_n = 0
    for question_id, group in transitions.groupby("question_id", sort=True):
        mask = mask_function(group).astype(bool)
        transitions_n += int(mask.sum())
        if mask.any():
            values.append(float(group.loc[mask, "delta_margin"].mean()))
    estimate, low, high = mean_ci(values, seed_offset)
    return {
        "estimate": estimate,
        "ci_low": low,
        "ci_high": high,
        "eligible_questions": len(values),
        "denominator_transitions": transitions_n,
    }


def weighted_average_precision(
    transitions: pd.DataFrame, cluster_counts: dict[str, int] | None = None
) -> tuple[float, float]:
    question_sizes = transitions.groupby("question_id").size()
    if cluster_counts is None:
        cluster_counts = {question: 1 for question in question_sizes.index}
    weights = transitions["question_id"].map(
        lambda question: cluster_counts.get(question, 0) / question_sizes[question]
    ).to_numpy(dtype=float)
    labels = transitions["support_gain"].to_numpy(dtype=bool)
    scores = transitions["delta_margin"].to_numpy(dtype=float)
    keep = weights > 0
    weights, labels, scores = weights[keep], labels[keep], scores[keep]
    base_rate = float(np.sum(weights * labels) / np.sum(weights))
    positive_weight = float(np.sum(weights * labels))
    order = np.argsort(-scores, kind="mergesort")
    weights, labels, scores = weights[order], labels[order], scores[order]
    starts = np.r_[0, np.flatnonzero(scores[1:] != scores[:-1]) + 1]
    group_positive = np.add.reduceat(weights * labels, starts)
    group_total = np.add.reduceat(weights, starts)
    cumulative_positive = np.cumsum(group_positive)
    cumulative_total = np.cumsum(group_total)
    precision = cumulative_positive / cumulative_total
    average_precision = float(np.sum((group_positive / positive_weight) * precision))
    return average_precision, base_rate


def bootstrap_ap(transitions: pd.DataFrame, seed_offset: int) -> dict[str, object]:
    questions = sorted(transitions["question_id"].unique())
    observed_ap, observed_base = weighted_average_precision(transitions)
    rng = np.random.default_rng(SEED + seed_offset)
    ap_draws = np.empty(BOOTSTRAP_DRAWS)
    base_draws = np.empty(BOOTSTRAP_DRAWS)
    for index in range(BOOTSTRAP_DRAWS):
        counts = Counter(rng.choice(questions, size=len(questions), replace=True))
        ap_draws[index], base_draws[index] = weighted_average_precision(transitions, counts)
    ap_low, ap_high = np.percentile(ap_draws, [2.5, 97.5])
    base_low, base_high = np.percentile(base_draws, [2.5, 97.5])
    return {
        "auprc": observed_ap,
        "auprc_ci_low": float(ap_low),
        "auprc_ci_high": float(ap_high),
        "base_rate": observed_base,
        "base_ci_low": float(base_low),
        "base_ci_high": float(base_high),
        "questions": len(questions),
        "transitions": len(transitions),
    }


def summarize_specificity(transitions: pd.DataFrame, sample: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    definitions = [
        ("P(margin rises | support gained)", lambda g: g["support_gain"], lambda g: g["sufficiency_rise"]),
        ("P(support gained | margin rises)", lambda g: g["sufficiency_rise"], lambda g: g["support_gain"]),
        ("P(margin rises | no support gained)", lambda g: ~g["support_gain"], lambda g: g["sufficiency_rise"]),
        (
            "P(margin rises | package changed, no support gained)",
            lambda g: g["package_changed"] & ~g["support_gain"],
            lambda g: g["sufficiency_rise"],
        ),
        (
            "P(margin rises | package unchanged)",
            lambda g: ~g["package_changed"],
            lambda g: g["sufficiency_rise"],
        ),
        ("Support-gain base rate", lambda g: pd.Series(True, index=g.index), lambda g: g["support_gain"]),
    ]
    rows = []
    for offset, (metric, denominator, outcome) in enumerate(definitions):
        row = question_conditional(transitions, denominator, outcome, 300 + offset)
        rows.append({"sample": sample, "metric": metric, **row})

    delta_definitions = [
        ("Mean margin change | support gained", lambda g: g["support_gain"]),
        ("Mean margin change | no support gained", lambda g: ~g["support_gain"]),
        ("Mean margin change | package unchanged", lambda g: ~g["package_changed"]),
    ]
    for offset, (metric, mask) in enumerate(delta_definitions):
        row = question_mean_delta(transitions, mask, 320 + offset)
        rows.append({"sample": sample, "metric": metric, **row})

    ap = bootstrap_ap(transitions, 340)
    rows.extend([
        {
            "sample": sample,
            "metric": "AUPRC: margin change predicts support gain",
            "estimate": ap["auprc"],
            "ci_low": ap["auprc_ci_low"],
            "ci_high": ap["auprc_ci_high"],
            "eligible_questions": ap["questions"],
            "denominator_transitions": ap["transitions"],
        },
        {
            "sample": sample,
            "metric": "AUPRC baseline: support-gain prevalence",
            "estimate": ap["base_rate"],
            "ci_low": ap["base_ci_low"],
            "ci_high": ap["base_ci_high"],
            "eligible_questions": ap["questions"],
            "denominator_transitions": ap["transitions"],
        },
    ])

    decomposition = (
        transitions.groupby(["support_gain", "package_changed"], as_index=False)
        .agg(
            transitions=("sufficiency_rise", "size"),
            raw_rise_fraction=("sufficiency_rise", "mean"),
            raw_mean_delta_margin=("delta_margin", "mean"),
            questions=("question_id", "nunique"),
        )
    )
    decomposition.insert(0, "sample", sample)
    return pd.DataFrame(rows), decomposition


def build_onsets(natural: pd.DataFrame, threshold: float) -> pd.DataFrame:
    rows = []
    for (question_id, run), trajectory in natural.groupby(["question_id", "run"], sort=True):
        trajectory = trajectory.sort_values("step")
        sufficient = trajectory.loc[trajectory["likelihood"].gt(threshold)]
        complete = trajectory.loc[np.isclose(trajectory["r"], 1)]
        t_s = None if sufficient.empty else int(sufficient.iloc[0]["step"])
        t_r = None if complete.empty else int(complete.iloc[0]["step"])
        if t_s is not None and t_r is not None:
            if t_s < t_r:
                category = "S before R"
            elif t_s == t_r:
                category = "S and R together"
            else:
                category = "R before S"
        elif t_s is not None:
            category = "S observed; R not observed"
        elif t_r is not None:
            category = "R observed; S not observed"
        else:
            category = "Neither observed"
        after_onset = trajectory.loc[trajectory["step"].ge(t_s)] if t_s is not None else trajectory.iloc[0:0]
        strictly_after = trajectory.loc[trajectory["step"].gt(t_s)] if t_s is not None else trajectory.iloc[0:0]
        rows.append({
            "question_id": question_id,
            "run": run,
            "gold_hops": int(trajectory.iloc[0]["gold_hops"]),
            "threshold": threshold,
            "t_s": t_s,
            "t_r": t_r,
            "lead_steps": (t_r - t_s) if t_s is not None and t_r is not None else math.nan,
            "category": category,
            "has_later_state_after_t_s": bool(len(strictly_after)) if t_s is not None else False,
            "reversal_after_t_s": (
                bool(strictly_after["likelihood"].le(threshold).any()) if len(strictly_after) else math.nan
            ),
            "persistence_ratio": (
                float(after_onset["likelihood"].gt(threshold).mean()) if len(after_onset) else math.nan
            ),
            "answer_accuracy_at_t_s": (
                float(trajectory.loc[trajectory["step"].eq(t_s), "official_score"].iloc[0])
                if t_s is not None else math.nan
            ),
            "answer_accuracy_at_t_r": (
                float(trajectory.loc[trajectory["step"].eq(t_r), "official_score"].iloc[0])
                if t_r is not None else math.nan
            ),
        })
    return pd.DataFrame(rows)


def onset_summary(onsets: pd.DataFrame, sample: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    question_ids = sorted(onsets["question_id"].unique())
    per_question = (
        pd.crosstab(onsets["question_id"], onsets["category"], normalize="index")
        .reindex(index=question_ids, columns=CATEGORY_ORDER, fill_value=0)
    )
    rows = []
    for offset, category in enumerate(CATEGORY_ORDER):
        estimate, low, high = mean_ci(per_question[category], 400 + offset)
        rows.append({
            "sample": sample,
            "threshold": float(onsets["threshold"].iloc[0]),
            "category": category,
            "trajectories": int(onsets["category"].eq(category).sum()),
            "total_trajectories": len(onsets),
            "question_weighted_fraction": estimate,
            "ci_low": low,
            "ci_high": high,
            "questions": len(question_ids),
        })

    event_rows = []
    metrics = [
        ("Reversal after first sufficiency onset", "reversal_after_t_s"),
        ("Persistence ratio after first sufficiency onset", "persistence_ratio"),
        ("Answer accuracy at first sufficiency onset", "answer_accuracy_at_t_s"),
        ("Answer accuracy at first full coverage", "answer_accuracy_at_t_r"),
        ("Lead in decision steps among trajectories with both events", "lead_steps"),
    ]
    for offset, (metric, column) in enumerate(metrics):
        question_values = onsets.groupby("question_id")[column].mean().dropna()
        estimate, low, high = mean_ci(question_values, 430 + offset)
        event_rows.append({
            "sample": sample,
            "threshold": float(onsets["threshold"].iloc[0]),
            "metric": metric,
            "estimate": estimate,
            "ci_low": low,
            "ci_high": high,
            "eligible_questions": len(question_values),
            "eligible_trajectories": int(onsets[column].notna().sum()),
        })
    return pd.DataFrame(rows), pd.DataFrame(event_rows)


def event_alignment(
    natural: pd.DataFrame, onsets: pd.DataFrame, offsets: range = range(-2, 3)
) -> tuple[pd.DataFrame, pd.DataFrame]:
    trajectory_rows = []
    keyed = natural.set_index(["question_id", "run", "step"])
    for onset in onsets.loc[onsets["t_r"].notna()].itertuples(index=False):
        for offset in offsets:
            key = (onset.question_id, onset.run, int(onset.t_r) + offset)
            if key not in keyed.index:
                continue
            state = keyed.loc[key]
            trajectory_rows.append({
                "question_id": onset.question_id,
                "run": onset.run,
                "offset": offset,
                "sufficiency_likelihood": float(state["likelihood"]),
                "native_margin": float(state["margin"]),
                "answer_accuracy": float(state["official_score"]),
            })
    trajectory = pd.DataFrame(trajectory_rows)
    question = trajectory.groupby(["question_id", "offset"], as_index=False)[
        ["sufficiency_likelihood", "native_margin", "answer_accuracy"]
    ].mean()
    rows = []
    for offset in offsets:
        selected = question.loc[question["offset"].eq(offset)]
        raw = trajectory.loc[trajectory["offset"].eq(offset)]
        for seed_offset, metric in enumerate(
            ["sufficiency_likelihood", "native_margin", "answer_accuracy"]
        ):
            estimate, low, high = mean_ci(selected[metric], 500 + 10 * (offset + 2) + seed_offset)
            rows.append({
                "offset": offset,
                "metric": metric,
                "estimate": estimate,
                "ci_low": low,
                "ci_high": high,
                "questions": selected["question_id"].nunique(),
                "trajectories": raw[["question_id", "run"]].drop_duplicates().shape[0],
            })
    return trajectory, pd.DataFrame(rows)


def transition_regression(transitions: pd.DataFrame) -> pd.DataFrame:
    # Support cannot increase if the retained package is unchanged. Restrict
    # this diagnostic regression to package-changing transitions so delta-M
    # distinguishes gold-support additions from other evidence additions.
    data = transitions.loc[transitions["package_changed"]].copy().reset_index(drop=True)
    data["trajectory_length_10"] = data["trajectory_length"] / 10
    data["gold_hops_centered"] = data["gold_hops"] - 2
    data["weight"] = 1 / data.groupby("question_id")["question_id"].transform("size")
    specifications = {
        "Unadjusted": ["delta_margin"],
        "Adjusted": [
            "delta_margin",
            "previous_r",
            "normalized_progress",
            "trajectory_length_10",
            "gold_hops_centered",
        ],
    }
    rows = []
    for name, columns in specifications.items():
        design = sm.add_constant(data[columns], has_constant="add")
        fit = sm.GEE(
            data["support_gain"].astype(int), design,
            groups=data["question_id"], family=sm.families.Binomial(),
            weights=data["weight"], cov_struct=sm.cov_struct.Independence(),
        ).fit()
        for term in design.columns:
            coefficient = float(fit.params[term])
            low, high = map(float, fit.conf_int().loc[term])
            rows.append({
                "model": name,
                "term": term,
                "coefficient": coefficient,
                "ci_low": low,
                "ci_high": high,
                "odds_ratio": math.exp(coefficient),
                "odds_ratio_ci_low": math.exp(low),
                "odds_ratio_ci_high": math.exp(high),
                "questions": data["question_id"].nunique(),
                "transitions": len(data),
            })
    return pd.DataFrame(rows)


def draw_event_figure(
    summary: pd.DataFrame, metric: str, stem: str, ylabel: str,
    threshold: float, alt_text: str,
) -> None:
    values = summary.loc[summary["metric"].eq(metric)].sort_values("offset")
    rc = {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 9.5,
        "axes.labelsize": 10.5,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "axes.edgecolor": "#505050",
        "axes.linewidth": 0.7,
        "axes.labelcolor": "#252525",
        "text.color": "#252525",
        "xtick.color": "#505050",
        "ytick.color": "#505050",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "savefig.facecolor": "white",
    }
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(4.7, 3.25), layout="constrained")
        ax.axhline(threshold, color="#A0A0A0", linewidth=0.7, linestyle=(0, (3, 3)), zorder=0)
        ax.axvline(0, color=BLUE, linewidth=0.9, linestyle=(0, (2, 2)), zorder=0)
        ax.fill_between(
            values["offset"], values["ci_low"], values["ci_high"],
            color=RED, alpha=0.13, linewidth=0,
        )
        ax.plot(values["offset"], values["estimate"], color=RED, linewidth=1.8, zorder=2)
        ax.scatter(
            values["offset"], values["estimate"], s=34, facecolor="white",
            edgecolor=RED, linewidth=1.25, zorder=3,
        )
        ax.text(0.04, 0.065, "First full coverage", transform=ax.get_xaxis_transform(),
                color=BLUE, fontsize=8.4, ha="left", va="bottom")
        annotation_y = threshold + (0.015 if metric == "sufficiency_likelihood" else 0.20)
        ax.text(-1.95, annotation_y, "Sufficient favored", color=GRAY, fontsize=8.2,
                ha="left", va="bottom")
        labels = [f"{int(row.offset):+d}\nn={int(row.questions)}" for row in values.itertuples()]
        labels = [label.replace("+0", "0") for label in labels]
        ax.set_xticks(values["offset"], labels)
        ax.set_xlim(-2.18, 2.18)
        if metric == "sufficiency_likelihood":
            ax.set_ylim(0, 1.035)
            ax.set_yticks([0, 0.25, 0.5, 0.75, 1], ["0", "0.25", "0.50", "0.75", "1"])
        else:
            lower = min(-0.7, float(values["ci_low"].min()) - 0.25)
            upper = max(7.5, float(values["ci_high"].max()) + 0.25)
            ax.set_ylim(lower, upper)
        ax.set_xlabel("Decision steps relative to first full coverage")
        ax.set_ylabel(ylabel)
        ax.grid(axis="y", color="#E6E6E6", linewidth=0.5)
        ax.set_axisbelow(True)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(length=3, width=0.7, pad=4)
        export_figure(
            fig, FIGURES / stem,
            formats=["pdf", "png"], dpi=600, bbox_inches=None,
            overwrite=True, write_manifest=True,
            provenance={
                "raw_data": str(UNITS_PATH),
                "raw_data_sha256": sha256(UNITS_PATH),
                "sample": "64 unconflicted questions; event-aligned natural Qwen3.6-27B trajectories with observed full coverage",
                "aggregation": "runs within question, then equal-weight questions at each integer offset",
                "uncertainty": f"95% pointwise question bootstrap; {BOOTSTRAP_DRAWS} draws; seed family {SEED}",
                "missing_data": "no padding outside observed trajectories; n under each tick gives contributing questions",
                "transformations": [
                    "align integer decision states to the first state with R=1",
                    "retain the native sufficient-vs-insufficient readout requested by the figure",
                    "no smoothing and no monotonicity constraint",
                ],
                "alt_text": alt_text,
                "destination": "General manuscript figure; journal requirements unspecified",
            },
        )
        plt.close(fig)


def compact_table(
    controlled: pd.DataFrame, specificity: pd.DataFrame,
    onset_categories: pd.DataFrame, onset_events: pd.DataFrame,
) -> pd.DataFrame:
    def take(frame: pd.DataFrame, column: str, value: str) -> pd.Series:
        selected = frame.loc[frame[column].eq(value)]
        assert len(selected) == 1
        return selected.iloc[0]

    rows = []
    for analysis, metric, label in [
        ("Any missing gold fact added", "Sufficiency likelihood", "Controlled support addition: likelihood change"),
        ("Any missing gold fact added", "Answer accuracy", "Controlled support addition: answer change"),
        ("Last missing gold fact added", "Sufficiency likelihood", "Completing support: likelihood change"),
        ("Last missing gold fact added", "Answer accuracy", "Completing support: answer change"),
    ]:
        row = controlled.loc[controlled["analysis"].eq(analysis) & controlled["metric"].eq(metric)].iloc[0]
        rows.append({"analysis": label, "estimate": row["estimate"], "ci_low": row["ci_low"], "ci_high": row["ci_high"], "unit": "difference"})
    for metric, label in [
        ("P(margin rises | support gained)", "Natural support gain: margin rises"),
        ("P(support gained | margin rises)", "Sufficiency rise: support gained"),
        ("P(margin rises | no support gained)", "No support gain: margin rises"),
    ]:
        row = take(specificity, "metric", metric)
        rows.append({"analysis": label, "estimate": row["estimate"], "ci_low": row["ci_low"], "ci_high": row["ci_high"], "unit": "fraction"})
    for category, label in [
        ("S before R", "Sufficiency onset before full coverage"),
        ("S observed; R not observed", "Sufficiency onset; full coverage never observed"),
    ]:
        row = take(onset_categories, "category", category)
        rows.append({"analysis": label, "estimate": row["question_weighted_fraction"], "ci_low": row["ci_low"], "ci_high": row["ci_high"], "unit": "fraction"})
    row = take(onset_events, "metric", "Reversal after first sufficiency onset")
    rows.append({"analysis": "Reversal after sufficiency onset", "estimate": row["estimate"], "ci_low": row["ci_low"], "ci_high": row["ci_high"], "unit": "fraction"})
    return pd.DataFrame(rows)


def write_report(summary: dict[str, object], table: pd.DataFrame) -> None:
    values = {row.analysis: row for row in table.itertuples(index=False)}
    ap = summary["specificity"]["auprc"]
    baseline = summary["specificity"]["auprc_baseline"]
    a_ts = summary["onset"]["answer_accuracy_at_t_s"]
    a_tr = summary["onset"]["answer_accuracy_at_t_r"]
    report = f"""# Evidence–sufficiency dynamics study

## 数据与口径

主分析使用 64 道无已知 official-gold 冲突的 FactConsolidation-MH 题目：192 条 Qwen3.6-27B 自然轨迹、1,181 个逐状态测量，以及 760 个受控证据条件。自然状态与受控条件的回答均为当前固定 evidence package 上的 5 次独立回答。原生充分性以 sufficient 相对 insufficient 的 logit margin（M）分析，图中显示其二状态 likelihood（S）。题目是统计独立单位；置信区间按题目重采样 {BOOTSTRAP_DRAWS:,} 次。

## Experiment 1：Evidence sensitivity

同题、同顺序和同证据槽数量下，以一条 gold fact 替换无关事实，共形成 1,072 个相邻配对。任意缺失 gold fact 的加入使 likelihood 平均增加 {values['Controlled support addition: likelihood change'].estimate:.3f}（95% CI {values['Controlled support addition: likelihood change'].ci_low:.3f}–{values['Controlled support addition: likelihood change'].ci_high:.3f}），当前证据包回答正确率增加 {values['Controlled support addition: answer change'].estimate:.3f}（{values['Controlled support addition: answer change'].ci_low:.3f}–{values['Controlled support addition: answer change'].ci_high:.3f}）。补齐最后一条 gold fact 时，likelihood 增加 {values['Completing support: likelihood change'].estimate:.3f}，回答正确率增加 {values['Completing support: answer change'].estimate:.3f}。受控结果支持充分性信号会响应真正有用的证据。

## Experiment 2：Evidence specificity

192 条自然轨迹产生 989 次相邻状态变化，其中 287 次增加了 gold coverage。按题目先计算条件比例再等权平均：有 support gain 时 margin 上升的概率为 {values['Natural support gain: margin rises'].estimate:.3f}（{values['Natural support gain: margin rises'].ci_low:.3f}–{values['Natural support gain: margin rises'].ci_high:.3f}）；margin 上升时同时出现 support gain 的概率只有 {values['Sufficiency rise: support gained'].estimate:.3f}（{values['Sufficiency rise: support gained'].ci_low:.3f}–{values['Sufficiency rise: support gained'].ci_high:.3f}）。没有 support gain 时，margin 上升的概率仍为 {values['No support gain: margin rises'].estimate:.3f}。

连续 margin 变化预测 support gain 的 AUPRC 为 {ap:.3f}，题目等权的 support-gain 基线为 {baseline:.3f}。因此，该信号对证据增加敏感，但一次充分性上涨本身并不能可靠指示 gold evidence 确实增加。

在 evidence package 完全不变的 608 次变化中，有 382 次 margin 上涨；按题目先求比例再平均为 {summary['specificity']['p_margin_rise_given_package_unchanged']:.3f}。这里的“不变”只指 retained evidence package；搜索结果、工具回执和对话历史仍可能变化。

## Experiment 3：Onset and persistence

以 M>0（等价于 S>0.5）定义首次 sufficiency onset。192 条轨迹中，133 条在完整 coverage 之前出现 onset，1 条与完整 coverage 同时出现，54 条出现 onset 但终止前始终没有达到完整 coverage，4 条两个事件都没有出现；没有轨迹先达到完整 coverage、再首次偏向 sufficient。

首次偏向 sufficient 时，当前 evidence package 的五次回答正确率均值只有 {a_ts:.3f}；首次达到完整 coverage 时为 {a_tr:.3f}。这表明 native sufficiency onset 通常明显早于当前证据包实际可稳定回答的时点。

在首次 onset 后仍有后续状态的轨迹中，question-weighted reversal rate 为 {values['Reversal after sufficiency onset'].estimate:.3f}（{values['Reversal after sufficiency onset'].ci_low:.3f}–{values['Reversal after sufficiency onset'].ci_high:.3f}）。充分性往往持续，但并非不可逆状态。

## 结论

现有数据支持三点：gold evidence 的受控增加会提高充分性；自然轨迹中的充分性上涨经常没有对应的 gold coverage 增长；充分性通常在 annotated evidence 完整之前形成，并在多数后续状态中保持。这里的 specificity 结论针对 annotated gold evidence，不能排除未标注但有用的信息或上下文变化。

## 主要产物

- `results/evidence-sufficiency-coupling.csv`：正文紧凑表。
- `figures/sufficiency-around-evidence-completion.pdf`：以首次完整 coverage 对齐的主图。
- `results/threshold-sensitivity.csv`、`hop-stratified.csv`、`full100-sensitivity.csv`：阈值、跳数和全量样本敏感性。
- `results/transition-regression.csv`、`answer-predictiveness.csv`：回归控制及逐状态回答预测结果。回归只分析 evidence package 发生变化的 381 次 transition，因为 package 不变时 gold support 不可能增加。
"""
    (HERE / "REPORT.zh-CN.md").write_text(report, encoding="utf-8")


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    units, natural = load_inputs()
    natural_for_export = natural.copy()
    natural_for_export["package_ids"] = natural_for_export["package_ids"].map(
        lambda value: json.dumps(list(value), ensure_ascii=False, separators=(",", ":"))
    )
    natural_for_export.to_csv(RESULTS / "natural-states-with-packages.csv", index=False)

    primary_natural = natural.loc[~natural["conflicted"]].copy()
    assert len(primary_natural) == 1181
    assert primary_natural["question_id"].nunique() == 64
    assert primary_natural[["question_id", "run"]].drop_duplicates().shape[0] == 192
    primary_transitions = build_transitions(primary_natural)
    assert len(primary_transitions) == 989
    primary_transitions.drop(columns=["package_ids", "previous_package_ids"]).to_csv(
        RESULTS / "natural-transitions.csv", index=False
    )

    pairs = controlled_pairs(units)
    controlled = summarize_controlled(pairs, "unconflicted")
    pairs.to_csv(RESULTS / "controlled-support-pairs.csv", index=False)
    controlled.to_csv(RESULTS / "controlled-effects.csv", index=False)

    specificity, decomposition = summarize_specificity(primary_transitions, "unconflicted")
    specificity.to_csv(RESULTS / "specificity.csv", index=False)
    decomposition.to_csv(RESULTS / "package-change-decomposition.csv", index=False)

    onsets = build_onsets(primary_natural, 0.5)
    categories, onset_events = onset_summary(onsets, "unconflicted")
    onsets.to_csv(RESULTS / "trajectory-onsets.csv", index=False)
    categories.to_csv(RESULTS / "onset-categories.csv", index=False)
    onset_events.to_csv(RESULTS / "onset-events.csv", index=False)

    aligned_trajectory, aligned_summary = event_alignment(primary_natural, onsets)
    aligned_trajectory.to_csv(RESULTS / "event-aligned-trajectories.csv", index=False)
    aligned_summary.to_csv(RESULTS / "event-aligned-summary.csv", index=False)
    draw_event_figure(
        aligned_summary, "sufficiency_likelihood",
        "sufficiency-around-evidence-completion", "Sufficiency likelihood", 0.5,
        "Mean sufficiency likelihood is already above 0.7 two decisions before full annotated evidence coverage, rises to about 0.98 at completion, and remains high among the smaller set of trajectories that continue afterward.",
    )
    draw_event_figure(
        aligned_summary, "native_margin",
        "native-margin-around-evidence-completion", "Native sufficiency margin", 0.0,
        "Mean native sufficiency margin is positive two decisions before full annotated evidence coverage and rises sharply at the completion event.",
    )

    threshold_tables = []
    for threshold in [0.5, 0.7, 0.9]:
        threshold_onsets = build_onsets(primary_natural, threshold)
        threshold_categories, threshold_events = onset_summary(threshold_onsets, "unconflicted")
        threshold_categories["record_type"] = "category"
        threshold_events["record_type"] = "event"
        threshold_tables.extend([threshold_categories, threshold_events])
    pd.concat(threshold_tables, ignore_index=True, sort=False).to_csv(
        RESULTS / "threshold-sensitivity.csv", index=False
    )

    hop_tables = []
    for hops, group in primary_natural.groupby("gold_hops"):
        hop_transitions = build_transitions(group)
        hop_specificity, _ = summarize_specificity(hop_transitions, f"{int(hops)}-hop")
        hop_onsets = build_onsets(group, 0.5)
        hop_categories, hop_events = onset_summary(hop_onsets, f"{int(hops)}-hop")
        hop_specificity["record_type"] = "specificity"
        hop_categories["record_type"] = "onset_category"
        hop_events["record_type"] = "onset_event"
        hop_tables.extend([hop_specificity, hop_categories, hop_events])
        hop_pairs = pairs.loc[pairs["gold_hops"].eq(hops)]
        hop_controlled = summarize_controlled(hop_pairs, f"{int(hops)}-hop")
        hop_controlled["record_type"] = "controlled"
        hop_tables.append(hop_controlled)
    pd.concat(hop_tables, ignore_index=True, sort=False).to_csv(
        RESULTS / "hop-stratified.csv", index=False
    )

    full_transitions = build_transitions(natural)
    full_specificity, _ = summarize_specificity(full_transitions, "all100")
    full_onsets = build_onsets(natural, 0.5)
    full_categories, full_events = onset_summary(full_onsets, "all100")
    full_specificity["record_type"] = "specificity"
    full_categories["record_type"] = "onset_category"
    full_events["record_type"] = "onset_event"
    full_pairs = controlled_pairs(units, include_conflicts=True)
    full_controlled = summarize_controlled(full_pairs, "all100")
    full_controlled["record_type"] = "controlled"
    pd.concat([full_specificity, full_categories, full_events, full_controlled], ignore_index=True, sort=False).to_csv(
        RESULTS / "full100-sensitivity.csv", index=False
    )

    regression = transition_regression(primary_transitions)
    regression.to_csv(RESULTS / "transition-regression.csv", index=False)
    answer_predictiveness = pd.read_csv(ANSWER_CV_PATH)
    answer_predictiveness.to_csv(RESULTS / "answer-predictiveness.csv", index=False)

    table = compact_table(controlled, specificity, categories, onset_events)
    table.to_csv(RESULTS / "evidence-sufficiency-coupling.csv", index=False)
    latex_rows = []
    for row in table.itertuples(index=False):
        latex_rows.append(
            f"{row.analysis} & {row.estimate:.3f} & [{row.ci_low:.3f}, {row.ci_high:.3f}] \\\\"
        )
    latex = "\n".join([
        r"\begin{tabular}{lcc}",
        r"\toprule",
        r"Analysis & Estimate & 95\% CI \\",
        r"\midrule",
        *latex_rows,
        r"\bottomrule",
        r"\end{tabular}",
    ]) + "\n"
    (RESULTS / "evidence-sufficiency-coupling.tex").write_text(latex, encoding="utf-8")

    spec_map = specificity.set_index("metric")["estimate"].to_dict()
    event_map = onset_events.set_index("metric")["estimate"].to_dict()
    result_summary = {
        "inputs": {
            "units": str(UNITS_PATH),
            "units_sha256": sha256(UNITS_PATH),
            "status": str(STATUS_PATH),
            "status_sha256": sha256(STATUS_PATH),
            "answer_predictiveness": str(ANSWER_CV_PATH),
            "answer_predictiveness_sha256": sha256(ANSWER_CV_PATH),
            "state_package_files": {str(run): {"path": str(path), "sha256": sha256(path)} for run, path in STATE_FILES.items()},
        },
        "primary_sample": {
            "questions": 64,
            "trajectories": 192,
            "states": 1181,
            "transitions": 989,
            "support_gain_transitions": int(primary_transitions["support_gain"].sum()),
            "controlled_conditions": 760,
            "controlled_pairs": len(pairs),
        },
        "specificity": {
            "p_margin_rise_given_support_gain": spec_map["P(margin rises | support gained)"],
            "p_support_gain_given_margin_rise": spec_map["P(support gained | margin rises)"],
            "p_margin_rise_given_no_support_gain": spec_map["P(margin rises | no support gained)"],
            "p_margin_rise_given_package_unchanged": spec_map["P(margin rises | package unchanged)"],
            "auprc": spec_map["AUPRC: margin change predicts support gain"],
            "auprc_baseline": spec_map["AUPRC baseline: support-gain prevalence"],
        },
        "onset": {
            "trajectory_category_counts": onsets["category"].value_counts().reindex(CATEGORY_ORDER, fill_value=0).to_dict(),
            "answer_accuracy_at_t_s": event_map["Answer accuracy at first sufficiency onset"],
            "answer_accuracy_at_t_r": event_map["Answer accuracy at first full coverage"],
            "reversal_rate": event_map["Reversal after first sufficiency onset"],
            "persistence_ratio": event_map["Persistence ratio after first sufficiency onset"],
        },
        "bootstrap": {"unit": "question", "draws": BOOTSTRAP_DRAWS, "seed_family": SEED},
    }
    (HERE / "summary.json").write_text(
        json.dumps(result_summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    write_report(result_summary, table)
    audit = audit_palette([RED, BLUE], background="#FFFFFF", role="graphical")
    (FIGURES / "palette-audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(result_summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
