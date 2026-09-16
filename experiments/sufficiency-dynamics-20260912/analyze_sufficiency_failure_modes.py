#!/usr/bin/env python3
"""Deep-dive analysis of Picorer sufficiency failure modes.

This analysis separates evidence committed by ``read`` from exact gold facts
visible in search previews, locates the first positive native sufficiency
state, measures sign reversals, diagnoses explicit-J response bias, and tests
whether terminal correctness depends jointly on committed evidence and the
native sufficiency sign.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Callable

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns


RED = "#C41230"
DARK_RED = "#8B1538"
TEAL = "#147D92"
DARK_TEAL = "#0A5364"
CHARCOAL = "#252A34"
GRAY = "#8C929C"
LIGHT_GRAY = "#D9DCE1"
PALE_GRAY = "#F1F2F4"
PALE_TEAL = "#A9D3D9"

INPUTS = {
    "Run 1": "coverage/run1/state-replica.csv",
    "Run 2": "coverage/run2/state-replica.csv",
    "Run 3": "coverage/complete-run/state-replica.csv",
}


def configure_style() -> None:
    sns.set_theme(context="paper", style="ticks")
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
            "font.size": 8.2,
            "axes.labelsize": 8.8,
            "axes.edgecolor": CHARCOAL,
            "axes.linewidth": 0.75,
            "axes.facecolor": "white",
            "xtick.labelsize": 7.8,
            "ytick.labelsize": 7.8,
            "figure.facecolor": "white",
            "savefig.facecolor": "white",
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.05,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def save_figure(figure: plt.Figure, path: Path) -> None:
    figure.savefig(path.with_suffix(".pdf"))
    figure.savefig(path.with_suffix(".png"), dpi=450)
    plt.close(figure)


def auc_rank(labels: pd.Series, scores: pd.Series) -> float:
    y = labels.to_numpy(dtype=bool)
    ranks = scores.rank(method="average").to_numpy(dtype=float)
    positives = int(y.sum())
    negatives = int((~y).sum())
    if not positives or not negatives:
        return math.nan
    return float(
        (ranks[y].sum() - positives * (positives + 1) / 2)
        / (positives * negatives)
    )


def cluster_bootstrap(
    frame: pd.DataFrame,
    statistic: Callable[[pd.DataFrame], float],
    rng: np.random.Generator,
    draws: int,
) -> tuple[float, float, float, int]:
    questions = frame["question_id"].drop_duplicates().to_numpy()
    groups = {
        question: frame[frame["question_id"] == question] for question in questions
    }
    observed = float(statistic(frame))
    values = []
    for _ in range(draws):
        selected = rng.choice(questions, size=len(questions), replace=True)
        sample = pd.concat([groups[question] for question in selected], ignore_index=True)
        value = float(statistic(sample))
        if np.isfinite(value):
            values.append(value)
    low, high = np.percentile(values, [2.5, 97.5])
    return observed, float(low), float(high), len(values)


def load_states(experiment_dir: Path, visible_path: Path) -> pd.DataFrame:
    frames = []
    for run, relative in INPUTS.items():
        frame = pd.read_csv(experiment_dir / relative)
        frame["round"] = run
        frames.append(frame)
    raw = pd.concat(frames, ignore_index=True)
    states = (
        raw.groupby(["round", "question_id", "decision_step"], as_index=False)
        .agg(
            trajectory_length=("decision_state_count", "first"),
            tau=("normalized_progress", "first"),
            committed_r=("gold_coverage_r", "first"),
            native_s=("native_logit_margin", "mean"),
            explicit_j=("j_sufficient_fraction", "mean"),
            action=("action_tool_names", "first"),
            correct=("final_correct", "first"),
            conflicted=("official_gold_lww_conflicted", "first"),
        )
        .sort_values(["round", "question_id", "decision_step"])
        .reset_index(drop=True)
    )
    visible = pd.read_csv(visible_path)
    states = states.merge(
        visible,
        on=["round", "question_id", "decision_step"],
        how="inner",
        validate="one_to_one",
    )
    if len(states) != 2150:
        raise ValueError(f"expected 2,150 states, found {len(states):,}")
    states["run_question"] = states["round"] + "::" + states["question_id"]
    states["native_positive"] = states["native_s"] > 0
    states["explicit_positive"] = states["explicit_j"] > 0.5
    states["terminal"] = states["decision_step"] == states["trajectory_length"]
    return states


def trajectory_summary(states: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for run_question, group in states.groupby("run_question", sort=False):
        group = group.sort_values("decision_step")
        positive = group[group["native_positive"]]
        full = group[group["committed_r"] >= 1 - 1e-12]
        first_positive = positive.iloc[0] if len(positive) else None
        first_full = full.iloc[0] if len(full) else None
        signs = group["native_positive"].astype(int).to_numpy()
        reversals = int((np.diff(signs) < 0).sum())
        if first_positive is None:
            crossing_class = "Never positive"
            committed_class = "Never positive"
            visible_class = "Never positive"
        else:
            crossing_class = "Reversal" if reversals else "Single transition"
            committed_class = (
                "None"
                if first_positive["committed_r"] <= 1e-12
                else "Complete"
                if first_positive["committed_r"] >= 1 - 1e-12
                else "Partial"
            )
            visible_value = first_positive["ever_seen_or_committed_coverage"]
            visible_class = (
                "None"
                if visible_value <= 1e-12
                else "Complete"
                if visible_value >= 1 - 1e-12
                else "Partial"
            )
        rows.append(
            {
                "run_question": run_question,
                "round": group["round"].iloc[0],
                "question_id": group["question_id"].iloc[0],
                "correct": bool(group["correct"].iloc[0]),
                "trajectory_length": int(group["trajectory_length"].iloc[0]),
                "ever_positive": first_positive is not None,
                "first_positive_step": (
                    int(first_positive["decision_step"])
                    if first_positive is not None
                    else math.nan
                ),
                "first_positive_tau": (
                    float(first_positive["tau"])
                    if first_positive is not None
                    else math.nan
                ),
                "first_positive_committed_r": (
                    float(first_positive["committed_r"])
                    if first_positive is not None
                    else math.nan
                ),
                "first_positive_visible_r": (
                    float(first_positive["ever_seen_or_committed_coverage"])
                    if first_positive is not None
                    else math.nan
                ),
                "first_positive_has_current_gold_preview": (
                    bool(first_positive["current_preview_gold_count"] > 0)
                    if first_positive is not None
                    else False
                ),
                "first_positive_before_committed_full": bool(
                    first_positive is not None
                    and (
                        first_full is None
                        or int(first_positive["decision_step"])
                        < int(first_full["decision_step"])
                    )
                ),
                "committed_class_at_first_positive": committed_class,
                "visible_class_at_first_positive": visible_class,
                "sign_reversals": reversals,
                "crossing_class": crossing_class,
            }
        )
    return pd.DataFrame(rows)


def first_positive_figure(trajectories: pd.DataFrame, output: Path) -> None:
    order = ["None", "Partial", "Complete", "Never positive"]
    colors = [PALE_GRAY, PALE_TEAL, DARK_TEAL, RED]
    labels = ["No gold fact", "Partial chain", "Complete chain", "Never positive"]
    rows = [
        ("Committed by read", "committed_class_at_first_positive"),
        ("Seen incl. search preview", "visible_class_at_first_positive"),
    ]
    figure, axis = plt.subplots(figsize=(5.2, 1.65))
    for y, (name, column) in enumerate(rows):
        left = 0.0
        counts = trajectories[column].value_counts()
        for category, color, label in zip(order, colors, labels):
            value = float(counts.get(category, 0)) / len(trajectories) * 100
            axis.barh(
                y,
                value,
                left=left,
                height=0.48,
                color=color,
                edgecolor="white",
                linewidth=0.8,
                label=label if y == 0 else None,
            )
            if value >= 6:
                text_color = "white" if category in {"Complete", "Never positive"} else CHARCOAL
                axis.text(
                    left + value / 2,
                    y,
                    f"{value:.1f}%",
                    ha="center",
                    va="center",
                    color=text_color,
                    fontsize=7.4,
                )
            left += value
    axis.set_yticks([0, 1], [row[0] for row in rows])
    axis.invert_yaxis()
    axis.set_xlim(0, 100)
    axis.set_xlabel("Share of trajectories")
    axis.xaxis.set_major_formatter(mpl.ticker.PercentFormatter())
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.8)
    axis.grid(axis="y", visible=False)
    sns.despine(ax=axis, left=True)
    axis.legend(
        loc="lower center",
        bbox_to_anchor=(0.5, 1.01),
        ncol=4,
        frameon=False,
        handlelength=1.1,
        columnspacing=1.1,
        fontsize=7.0,
    )
    save_figure(figure, output / "11-first-positive-evidence")


def terminal_gate(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, dict]:
    terminal = states[states["terminal"]].copy()
    terminal["full"] = terminal["committed_r"] >= 1 - 1e-12
    questions = terminal["question_id"].drop_duplicates().to_list()
    question_index = {question: index for index, question in enumerate(questions)}
    draw_counts = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    summaries = []
    rate_draws: dict[tuple[bool, bool], np.ndarray] = {}
    for full in (False, True):
        for positive in (False, True):
            subset = terminal[
                (terminal["full"] == full)
                & (terminal["native_positive"] == positive)
            ]
            totals_by_question = (
                subset.groupby("question_id").size().reindex(questions, fill_value=0)
            ).to_numpy(dtype=float)
            correct_by_question = (
                subset.groupby("question_id")["correct"]
                .sum()
                .reindex(questions, fill_value=0)
            ).to_numpy(dtype=float)
            sampled_totals = (draw_counts * totals_by_question).sum(axis=1)
            sampled_correct = (draw_counts * correct_by_question).sum(axis=1)
            sampled_rates = np.divide(
                sampled_correct,
                sampled_totals,
                out=np.full(draws, np.nan),
                where=sampled_totals > 0,
            )
            rate_draws[(full, positive)] = sampled_rates
            valid_rates = sampled_rates[np.isfinite(sampled_rates)]
            low, high = np.percentile(valid_rates, [2.5, 97.5])
            summaries.append(
                {
                    "full_committed_coverage": full,
                    "native_positive": positive,
                    "trajectories": len(subset),
                    "correct": int(subset["correct"].sum()),
                    "accuracy": float(subset["correct"].mean()),
                    "ci_low": float(low),
                    "ci_high": float(high),
                    "bootstrap_valid_draws": len(valid_rates),
                }
            )
    summary = pd.DataFrame(summaries)

    observed_rates = {
        (bool(row.full_committed_coverage), bool(row.native_positive)): float(
            row.accuracy
        )
        for row in summary.itertuples(index=False)
    }
    contrast_values = {
        "positive_minus_nonpositive_when_full": (
            observed_rates[(True, True)] - observed_rates[(True, False)],
            rate_draws[(True, True)] - rate_draws[(True, False)],
        ),
        "positive_minus_nonpositive_when_incomplete": (
            observed_rates[(False, True)] - observed_rates[(False, False)],
            rate_draws[(False, True)] - rate_draws[(False, False)],
        ),
    }
    contrast_values["difference_in_differences"] = (
        contrast_values["positive_minus_nonpositive_when_full"][0]
        - contrast_values["positive_minus_nonpositive_when_incomplete"][0],
        contrast_values["positive_minus_nonpositive_when_full"][1]
        - contrast_values["positive_minus_nonpositive_when_incomplete"][1],
    )
    contrasts = {}
    for name, (estimate, sampled) in contrast_values.items():
        valid = sampled[np.isfinite(sampled)]
        low, high = np.percentile(valid, [2.5, 97.5])
        contrasts[name] = {
            "estimate": float(estimate),
            "ci_low": float(low),
            "ci_high": float(high),
            "bootstrap_valid_draws": len(valid),
        }

    aucs = {}
    for full in (False, True):
        subset = terminal[terminal["full"] == full].sort_values("native_s")
        observed = auc_rank(subset["correct"], subset["native_s"])
        row_question_indices = np.array(
            [question_index[value] for value in subset["question_id"]], dtype=int
        )
        row_weights = draw_counts[:, row_question_indices]
        labels = subset["correct"].to_numpy(dtype=bool)
        scores = subset["native_s"].to_numpy(dtype=float)
        numerator = np.zeros(draws, dtype=float)
        cumulative_negative = np.zeros(draws, dtype=float)
        for score in np.unique(scores):
            tied = np.isclose(scores, score, rtol=0, atol=1e-12)
            positive_weight = row_weights[:, tied & labels].sum(axis=1)
            negative_weight = row_weights[:, tied & ~labels].sum(axis=1)
            numerator += positive_weight * (
                cumulative_negative + 0.5 * negative_weight
            )
            cumulative_negative += negative_weight
        total_positive = row_weights[:, labels].sum(axis=1)
        total_negative = row_weights[:, ~labels].sum(axis=1)
        sampled_auc = np.divide(
            numerator,
            total_positive * total_negative,
            out=np.full(draws, np.nan),
            where=(total_positive > 0) & (total_negative > 0),
        )
        valid_auc = sampled_auc[np.isfinite(sampled_auc)]
        low, high = np.percentile(valid_auc, [2.5, 97.5])
        aucs["full" if full else "incomplete"] = {
            "estimate": float(observed),
            "ci_low": float(low),
            "ci_high": float(high),
            "bootstrap_valid_draws": len(valid_auc),
        }
    contrasts["native_s_auc_within_coverage_stratum"] = aucs
    return summary, contrasts


def terminal_gate_figure(summary: pd.DataFrame, output: Path) -> None:
    figure, axis = plt.subplots(figsize=(4.25, 3.1))
    x = np.array([0.0, 1.0])
    for positive, color, marker, label, offset in (
        (False, GRAY, "o", "S ≤ 0", -0.055),
        (True, RED, "D", "S > 0", 0.055),
    ):
        subset = summary[summary["native_positive"] == positive].sort_values(
            "full_committed_coverage"
        )
        values = subset["accuracy"].to_numpy() * 100
        low = subset["ci_low"].to_numpy() * 100
        high = subset["ci_high"].to_numpy() * 100
        positions = x + offset
        axis.plot(
            positions,
            values,
            color=color,
            linewidth=1.4,
            marker=marker,
            markersize=6.2,
            label=label,
        )
        axis.errorbar(
            positions,
            values,
            yerr=np.vstack([values - low, high - values]),
            fmt="none",
            ecolor=color,
            elinewidth=1.1,
            capsize=3,
        )
        for px, value, count in zip(
            positions, values, subset["trajectories"].to_numpy()
        ):
            axis.annotate(
                f"{value:.1f}%\nn={count}",
                (px, value),
                xytext=(0, 10),
                textcoords="offset points",
                ha="center",
                va="bottom",
                fontsize=7.1,
                color=color,
            )
    axis.set_xlim(-0.25, 1.25)
    axis.set_ylim(0, 100)
    axis.set_xticks(x, ["Incomplete R", "Complete R"])
    axis.set_ylabel("Final answer accuracy")
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter())
    axis.grid(axis="y", color=LIGHT_GRAY, linewidth=0.55, alpha=0.8)
    axis.grid(axis="x", visible=False)
    sns.despine(ax=axis)
    axis.legend(loc="upper left", frameon=False)
    save_figure(figure, output / "12-terminal-evidence-gate")


def j_bias_summary(states: pd.DataFrame) -> pd.DataFrame:
    subsets = [
        ("Before retrieval", states[states["decision_step"] == 1]),
        ("All R=0 states", states[np.isclose(states["committed_r"], 0)]),
        ("All states", states),
    ]
    rows = []
    for label, subset in subsets:
        rows.append(
            {
                "subset": label,
                "states": len(subset),
                "native_positive_rate": float(subset["native_positive"].mean()),
                "explicit_majority_sufficient_rate": float(
                    subset["explicit_positive"].mean()
                ),
                "explicit_mean_sufficient_fraction": float(
                    subset["explicit_j"].mean()
                ),
            }
        )
    return pd.DataFrame(rows)


def j_bias_figure(summary: pd.DataFrame, output: Path) -> None:
    figure, axis = plt.subplots(figsize=(4.7, 2.75))
    y = np.arange(len(summary))
    native = summary["native_positive_rate"].to_numpy() * 100
    explicit = summary["explicit_majority_sufficient_rate"].to_numpy() * 100
    for values, color, marker, label in (
        (native, DARK_TEAL, "o", "Native S > 0"),
        (explicit, RED, "D", "Explicit J majority"),
    ):
        axis.scatter(values, y, color=color, marker=marker, s=32, label=label, zorder=3)
        for value, py in zip(values, y):
            axis.annotate(
                f"{value:.1f}%",
                (value, py),
                xytext=(5, 0),
                textcoords="offset points",
                va="center",
                fontsize=7.3,
                color=color,
            )
    for py, left, right in zip(y, native, explicit):
        axis.plot([left, right], [py, py], color=LIGHT_GRAY, linewidth=1.1, zorder=1)
    axis.set_yticks(y, summary["subset"])
    axis.invert_yaxis()
    axis.set_xlim(-3, 108)
    axis.set_xlabel("States judged sufficient")
    axis.xaxis.set_major_formatter(mpl.ticker.PercentFormatter())
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.8)
    axis.grid(axis="y", visible=False)
    sns.despine(ax=axis, left=True)
    axis.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01), ncol=2, frameon=False)
    save_figure(figure, output / "13-explicit-j-bias")


def reversal_figure(trajectories: pd.DataFrame, output: Path) -> None:
    order = ["Never positive", "Single transition", "Reversal"]
    labels = ["Never becomes positive", "One-way switch", "Turns negative again"]
    counts = trajectories["crossing_class"].value_counts()
    values = np.array([int(counts.get(name, 0)) for name in order])
    figure, axis = plt.subplots(figsize=(4.2, 2.65))
    bars = axis.bar(
        np.arange(3),
        values / len(trajectories) * 100,
        color=[GRAY, DARK_TEAL, RED],
        width=0.58,
    )
    axis.bar_label(
        bars,
        labels=[f"{value} ({value / len(trajectories):.1%})" for value in values],
        padding=4,
        fontsize=7.4,
    )
    axis.set_xticks(np.arange(3), labels)
    axis.set_ylabel("Share of trajectories")
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter())
    axis.set_ylim(0, 82)
    axis.grid(axis="y", color=LIGHT_GRAY, linewidth=0.55, alpha=0.8)
    axis.grid(axis="x", visible=False)
    sns.despine(ax=axis)
    save_figure(figure, output / "14-native-sign-reversals")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--experiment-dir", type=Path, default=Path(__file__).resolve().parent
    )
    parser.add_argument(
        "--visible-context",
        type=Path,
        default=Path(__file__).resolve().parent
        / "analysis-rs-v2/three-rounds/visible-context-coverage.csv",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent
        / "analysis-rs-v2/three-rounds/deep-dive",
    )
    parser.add_argument("--bootstrap-draws", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    configure_style()
    rng = np.random.default_rng(args.seed)

    states = load_states(args.experiment_dir, args.visible_context)
    trajectories = trajectory_summary(states)
    terminal_summary, terminal_contrasts = terminal_gate(
        states, rng, args.bootstrap_draws
    )
    j_summary = j_bias_summary(states)

    first_positive_figure(trajectories, args.output_dir)
    terminal_gate_figure(terminal_summary, args.output_dir)
    j_bias_figure(j_summary, args.output_dir)
    reversal_figure(trajectories, args.output_dir)

    states.to_csv(args.output_dir / "states-with-visible-context.csv", index=False)
    trajectories.to_csv(args.output_dir / "trajectory-crossings.csv", index=False)
    terminal_summary.to_csv(args.output_dir / "terminal-gate.csv", index=False)
    j_summary.to_csv(args.output_dir / "explicit-j-bias.csv", index=False)

    first_positive = trajectories[trajectories["ever_positive"]]
    first_positive_r0 = first_positive[
        np.isclose(first_positive["first_positive_committed_r"], 0)
    ]
    nonterminal = states[~states["terminal"]]
    terminal = states[states["terminal"]].copy()
    terminal["full"] = terminal["committed_r"] >= 1 - 1e-12
    terminal["seen_full"] = (
        terminal["ever_seen_or_committed_coverage"] >= 1 - 1e-12
    )
    preview_only_full = terminal[(~terminal["full"]) & terminal["seen_full"]]

    summary = {
        "analysis_version": 1,
        "sample": {
            "questions": int(states["question_id"].nunique()),
            "trajectories": len(trajectories),
            "states": len(states),
        },
        "first_positive_native_s": {
            "trajectories_ever_positive": int(trajectories["ever_positive"].sum()),
            "trajectories_positive_before_full_committed_evidence": int(
                trajectories["first_positive_before_committed_full"].sum()
            ),
            "first_positive_at_zero_committed_coverage": len(first_positive_r0),
            "first_positive_with_current_exact_gold_preview": int(
                first_positive["first_positive_has_current_gold_preview"].sum()
            ),
            "zero_committed_first_positive_with_current_exact_gold_preview": int(
                first_positive_r0[
                    "first_positive_has_current_gold_preview"
                ].sum()
            ),
            "committed_evidence_classes": trajectories[
                "committed_class_at_first_positive"
            ].value_counts().to_dict(),
            "visible_evidence_classes": trajectories[
                "visible_class_at_first_positive"
            ].value_counts().to_dict(),
            "median_normalized_position": float(
                first_positive["first_positive_tau"].median()
            ),
        },
        "native_s_dynamics": {
            "nonterminal_states": len(nonterminal),
            "nonterminal_positive_states": int(
                nonterminal["native_positive"].sum()
            ),
            "trajectories_with_positive_to_nonpositive_reversal": int(
                (trajectories["sign_reversals"] > 0).sum()
            ),
            "reversal_rate": float((trajectories["sign_reversals"] > 0).mean()),
        },
        "explicit_j": {
            "first_state_native_positive_rate": float(
                states.loc[states["decision_step"] == 1, "native_positive"].mean()
            ),
            "first_state_explicit_majority_sufficient_rate": float(
                states.loc[states["decision_step"] == 1, "explicit_positive"].mean()
            ),
            "first_state_mean_explicit_sufficient_fraction": float(
                states.loc[states["decision_step"] == 1, "explicit_j"].mean()
            ),
            "all_state_sign_agreement": float(
                (states["native_positive"] == states["explicit_positive"]).mean()
            ),
            "all_state_pearson": float(
                states[["native_s", "explicit_j"]].corr().iloc[0, 1]
            ),
        },
        "preview_handoff_gap": {
            "terminal_incomplete_committed_but_complete_ever_seen": len(
                preview_only_full
            ),
            "correct": int(preview_only_full["correct"].sum()),
            "native_positive": int(preview_only_full["native_positive"].sum()),
            "matching_rule": "exact normalized gold statement in current search preview; cumulative union is a lower-bound audit",
        },
        "terminal_gate": {
            "cells": terminal_summary.to_dict(orient="records"),
            "contrasts": terminal_contrasts,
            "per_round": [
                {
                    "round": run,
                    "full": bool(full),
                    "native_positive": bool(positive),
                    "trajectories": len(subset),
                    "accuracy": float(subset["correct"].mean()),
                }
                for (run, full, positive), subset in terminal.groupby(
                    ["round", "full", "native_positive"]
                )
            ],
        },
    }
    (args.output_dir / "deep-analysis-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
