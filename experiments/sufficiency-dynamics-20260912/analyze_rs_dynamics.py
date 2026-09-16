#!/usr/bin/env python3
"""Question-balanced analysis and publication figures for Picorer R--S dynamics.

The script treats the sufficient--insufficient native logit margin as the
primary sufficiency readout.  Model replicas are first collapsed within a
state; repeated states are then aggregated within a trajectory wherever the
estimand is conditional on a coverage level.  Confidence intervals resample
underlying questions, preserving all independent trajectory replicates for a
sampled question.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Callable, Iterable

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns


RED = "#C41230"
DARK_RED = "#8B1538"
TEAL = "#147D92"
NAVY = "#182C4B"
CHARCOAL = "#252A34"
GRAY = "#777D87"
LIGHT_GRAY = "#D9DCE1"
PALE_GRAY = "#F4F5F6"
WHITE = "#FFFFFF"


def parse_round(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("round must have form LABEL=/path/to/state-replica.csv")
    label, raw_path = value.split("=", 1)
    if not label.strip() or not raw_path.strip():
        raise argparse.ArgumentTypeError("round label and path must both be non-empty")
    return label.strip(), Path(raw_path).expanduser().resolve()


def configure_style() -> None:
    sns.set_theme(context="paper", style="ticks")
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
            "font.size": 8.0,
            "font.weight": "normal",
            "axes.labelsize": 8.5,
            "axes.labelweight": "normal",
            "axes.labelcolor": CHARCOAL,
            "axes.edgecolor": CHARCOAL,
            "axes.linewidth": 0.75,
            "axes.facecolor": WHITE,
            "axes.titlesize": 9.0,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "xtick.color": CHARCOAL,
            "ytick.color": CHARCOAL,
            "xtick.major.width": 0.7,
            "ytick.major.width": 0.7,
            "xtick.major.size": 3.0,
            "ytick.major.size": 3.0,
            "legend.fontsize": 7.4,
            "legend.frameon": False,
            "figure.facecolor": WHITE,
            "savefig.facecolor": WHITE,
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.04,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def tidy_axis(axis: plt.Axes, *, ygrid: bool = True) -> None:
    sns.despine(ax=axis, trim=False)
    axis.set_axisbelow(True)
    if ygrid:
        axis.grid(axis="y", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    axis.grid(axis="x", visible=False)


def save_figure(figure: plt.Figure, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(path.with_suffix(".pdf"))
    figure.savefig(path.with_suffix(".png"), dpi=450)
    plt.close(figure)


def percentile_interval(values: np.ndarray) -> tuple[float, float]:
    clean = np.asarray(values, dtype=float)
    clean = clean[np.isfinite(clean)]
    if not len(clean):
        return math.nan, math.nan
    low, high = np.percentile(clean, [2.5, 97.5])
    return float(low), float(high)


def bootstrap_rows(
    values: np.ndarray, rng: np.random.Generator, draws: int
) -> tuple[float, float, float]:
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if not len(values):
        return math.nan, math.nan, math.nan
    estimate = float(values.mean())
    if len(values) == 1:
        return estimate, estimate, estimate
    sampled = rng.integers(0, len(values), size=(draws, len(values)))
    replicates = values[sampled].mean(axis=1)
    low, high = percentile_interval(replicates)
    return estimate, low, high


def rank_average(values: Iterable[float]) -> np.ndarray:
    return pd.Series(np.asarray(list(values), dtype=float)).rank(method="average").to_numpy()


def pearson(x: Iterable[float], y: Iterable[float]) -> float:
    left = np.asarray(list(x), dtype=float)
    right = np.asarray(list(y), dtype=float)
    mask = np.isfinite(left) & np.isfinite(right)
    if mask.sum() < 2:
        return math.nan
    return float(np.corrcoef(left[mask], right[mask])[0, 1])


def auc_rank(labels: Iterable[bool], scores: Iterable[float]) -> float:
    labels_array = np.asarray(list(labels), dtype=bool)
    scores_array = np.asarray(list(scores), dtype=float)
    positives = int(labels_array.sum())
    negatives = int((~labels_array).sum())
    if not positives or not negatives:
        return math.nan
    ranks = rank_average(scores_array)
    rank_sum = float(ranks[labels_array].sum())
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def load_and_validate(rounds: list[tuple[str, Path]]) -> tuple[pd.DataFrame, dict]:
    frames: list[pd.DataFrame] = []
    validation: dict[str, dict] = {}
    required = {
        "question_id",
        "decision_step",
        "decision_state_count",
        "normalized_progress",
        "gold_coverage_r",
        "official_gold_lww_conflicted",
        "final_correct",
        "replica",
        "j_sample_count",
        "native_sufficient_likelihood",
        "native_logit_margin",
    }
    for label, path in rounds:
        frame = pd.read_csv(path)
        missing = sorted(required - set(frame.columns))
        if missing:
            raise ValueError(f"{path} is missing columns: {missing}")
        frame = frame.copy()
        frame["round"] = label
        state_sizes = frame.groupby(["question_id", "decision_step"]).size()
        if not (state_sizes == 2).all():
            bad = state_sizes[state_sizes != 2]
            raise ValueError(f"{label}: {len(bad)} states do not have exactly two replicas")
        if set(frame["replica"].unique()) != {"qwen-r1", "qwen-r2"}:
            raise ValueError(f"{label}: unexpected replica labels {sorted(frame['replica'].unique())}")
        validation[label] = {
            "path": str(path),
            "questions": int(frame["question_id"].nunique()),
            "states": int(len(state_sizes)),
            "state_replica_rows": int(len(frame)),
            "replicas_per_state": sorted(int(x) for x in state_sizes.unique()),
            "j_samples_per_state_replica": sorted(int(x) for x in frame["j_sample_count"].unique()),
            "coverage_monotone": bool(
                frame.drop_duplicates(["question_id", "decision_step"])
                .sort_values(["question_id", "decision_step"])
                .groupby("question_id")["gold_coverage_r"]
                .apply(lambda x: bool((x.diff().fillna(0) >= -1e-12).all()))
                .all()
            ),
        }
        frames.append(frame)
    raw = pd.concat(frames, ignore_index=True)
    return raw, validation


def collapse_replicas(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.copy()
    raw["replica_positive"] = raw["native_logit_margin"] > 0
    states = (
        raw.groupby(["round", "question_id", "decision_step"], as_index=False)
        .agg(
            trajectory_length=("decision_state_count", "first"),
            tau=("normalized_progress", "first"),
            r=("gold_coverage_r", "first"),
            margin=("native_logit_margin", "mean"),
            native_probability=("native_sufficient_likelihood", "mean"),
            positive_replicas=("replica_positive", "mean"),
            correct=("final_correct", "first"),
            conflicted=("official_gold_lww_conflicted", "first"),
            replica_margin_sd=("native_logit_margin", "std"),
        )
        .sort_values(["round", "question_id", "decision_step"])
        .reset_index(drop=True)
    )
    states["run_question"] = states["round"] + "::" + states["question_id"]
    states["native_positive"] = states["margin"] > 0
    states["delta_r"] = states.groupby("run_question")["r"].diff()
    states["delta_margin"] = states.groupby("run_question")["margin"].diff()
    states["evidence_gain"] = states["delta_r"].fillna(0) > 1e-12
    return states


def question_balanced_coverage(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, pd.DataFrame]:
    within_trajectory = (
        states.groupby(["round", "question_id", "r"], as_index=False)
        .agg(
            margin=("margin", "mean"),
            stop_rate=("native_positive", "mean"),
            native_probability=("native_probability", "mean"),
            states=("decision_step", "size"),
        )
    )
    # The same benchmark question can appear in multiple independent rounds.
    # Average those rounds before the outer question-level bootstrap.
    per_question = (
        within_trajectory.groupby(["question_id", "r"], as_index=False)
        .agg(
            margin=("margin", "mean"),
            stop_rate=("stop_rate", "mean"),
            native_probability=("native_probability", "mean"),
            rounds=("round", "nunique"),
        )
        .sort_values(["r", "question_id"])
    )
    rows: list[dict] = []
    for r_value, subset in per_question.groupby("r", sort=True):
        row = {"r": float(r_value), "questions": int(subset["question_id"].nunique())}
        for metric in ("margin", "stop_rate", "native_probability"):
            mean, low, high = bootstrap_rows(subset[metric].to_numpy(), rng, draws)
            row[f"{metric}_mean"] = mean
            row[f"{metric}_ci_low"] = low
            row[f"{metric}_ci_high"] = high
        rows.append(row)
    return per_question, pd.DataFrame(rows)


def interpolate_trajectory(subset: pd.DataFrame, grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    subset = subset.sort_values("decision_step")
    tau = subset["tau"].to_numpy(dtype=float)
    margin = subset["margin"].to_numpy(dtype=float)
    r = subset["r"].to_numpy(dtype=float)
    margin_grid = np.interp(grid, tau, margin, left=margin[0], right=margin[-1])
    indices = np.searchsorted(tau, grid, side="right") - 1
    indices = np.clip(indices, 0, len(r) - 1)
    return r[indices], margin_grid


def temporal_curves(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> pd.DataFrame:
    grid = np.linspace(0, 1, 51)
    trajectory_rows: list[dict] = []
    for (round_label, question_id), subset in states.groupby(["round", "question_id"]):
        r_values, margin_values = interpolate_trajectory(subset, grid)
        for index, tau in enumerate(grid):
            trajectory_rows.append(
                {
                    "round": round_label,
                    "question_id": question_id,
                    "tau": float(tau),
                    "r": float(r_values[index]),
                    "margin": float(margin_values[index]),
                }
            )
    trajectories = pd.DataFrame(trajectory_rows)
    per_question = (
        trajectories.groupby(["question_id", "tau"], as_index=False)[["r", "margin"]]
        .mean()
    )
    rows: list[dict] = []
    for tau, subset in per_question.groupby("tau", sort=True):
        row = {"tau": float(tau), "questions": int(len(subset))}
        for metric in ("r", "margin"):
            mean, low, high = bootstrap_rows(subset[metric].to_numpy(), rng, draws)
            row[f"{metric}_mean"] = mean
            row[f"{metric}_ci_low"] = low
            row[f"{metric}_ci_high"] = high
        rows.append(row)
    return pd.DataFrame(rows)


def within_components(
    states: pd.DataFrame,
    outcome: str = "margin",
    predictors: tuple[str, ...] = ("r", "tau"),
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    data = states.copy()
    for column in (*predictors, outcome):
        data[f"{column}_within"] = data[column] - data.groupby("run_question")[column].transform("mean")
    lengths = data.groupby("run_question")["decision_step"].transform("size").to_numpy(dtype=float)
    data["weight"] = 1.0 / lengths
    x = data[[f"{column}_within" for column in predictors]].to_numpy(dtype=float)
    y = data[f"{outcome}_within"].to_numpy(dtype=float)
    weights = data["weight"].to_numpy(dtype=float)
    component_rows = []
    for question_id, indices in data.groupby("question_id").indices.items():
        local_x = x[indices]
        local_y = y[indices]
        local_w = weights[indices]
        component_rows.append(
            (
                question_id,
                local_x.T @ (local_w[:, None] * local_x),
                local_x.T @ (local_w * local_y),
                float(np.sum(local_w * local_y**2)),
            )
        )
    questions = np.asarray([row[0] for row in component_rows], dtype=object)
    matrices = np.stack([row[1] for row in component_rows])
    vectors = np.stack([row[2] for row in component_rows])
    totals = np.asarray([row[3] for row in component_rows], dtype=float)
    return questions, matrices, vectors, totals


def weighted_within_fit(
    states: pd.DataFrame,
    outcome: str = "margin",
    predictors: tuple[str, ...] = ("r", "tau"),
) -> tuple[np.ndarray, float]:
    _, matrices, vectors, totals = within_components(states, outcome, predictors)
    matrix = matrices.sum(axis=0)
    vector = vectors.sum(axis=0)
    beta, *_ = np.linalg.lstsq(matrix, vector, rcond=None)
    residual = float(totals.sum() - 2 * beta @ vector + beta @ matrix @ beta)
    total = float(totals.sum())
    r_squared = 1 - residual / total if total > 0 else math.nan
    return beta, r_squared


def bootstrap_within_fit(
    states: pd.DataFrame,
    rng: np.random.Generator,
    draws: int,
    outcome: str = "margin",
    predictors: tuple[str, ...] = ("r", "tau"),
) -> tuple[np.ndarray, np.ndarray]:
    questions, matrices, vectors, _ = within_components(states, outcome, predictors)
    counts = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    sampled_matrices = np.einsum("dq,qij->dij", counts, matrices)
    sampled_vectors = np.einsum("dq,qj->dj", counts, vectors)
    estimates = np.empty((draws, len(predictors)), dtype=float)
    for draw in range(draws):
        estimates[draw], *_ = np.linalg.lstsq(
            sampled_matrices[draw], sampled_vectors[draw], rcond=None
        )
    return np.percentile(estimates, 2.5, axis=0), np.percentile(estimates, 97.5, axis=0)


def event_analysis(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    adjacent = states.dropna(subset=["delta_margin", "delta_r"]).copy()
    adjacent["event"] = np.where(adjacent["evidence_gain"], "Gold-evidence gain", "No gold-evidence gain")
    per_trajectory = (
        adjacent.groupby(["round", "question_id", "event"], as_index=False)
        .agg(
            delta_margin=("delta_margin", "mean"),
            positive_shift=("delta_margin", lambda x: float((x > 0).mean())),
            transitions=("delta_margin", "size"),
        )
    )
    per_question = (
        per_trajectory.groupby(["question_id", "event"], as_index=False)
        .agg(
            delta_margin=("delta_margin", "mean"),
            positive_shift=("positive_shift", "mean"),
            rounds=("round", "nunique"),
        )
    )
    rows: list[dict] = []
    for event, subset in per_question.groupby("event", sort=False):
        mean, low, high = bootstrap_rows(subset["delta_margin"].to_numpy(), rng, draws)
        rate, rate_low, rate_high = bootstrap_rows(subset["positive_shift"].to_numpy(), rng, draws)
        rows.append(
            {
                "event": event,
                "questions": int(len(subset)),
                "delta_margin_mean": mean,
                "delta_margin_ci_low": low,
                "delta_margin_ci_high": high,
                "positive_shift_rate": rate,
                "positive_shift_ci_low": rate_low,
                "positive_shift_ci_high": rate_high,
            }
        )
    wide = per_question.pivot(index="question_id", columns="event", values="delta_margin").dropna()
    paired = wide["Gold-evidence gain"] - wide["No gold-evidence gain"]
    effect, effect_low, effect_high = bootstrap_rows(paired.to_numpy(), rng, draws)
    adjacent["gain_indicator"] = adjacent["evidence_gain"].astype(float)
    controlled_beta, controlled_r_squared = weighted_within_fit(
        adjacent, "delta_margin", ("gain_indicator", "tau")
    )
    controlled_low, controlled_high = bootstrap_within_fit(
        adjacent, rng, draws, "delta_margin", ("gain_indicator", "tau")
    )
    contrast = {
        "questions_with_both_event_types": int(len(paired)),
        "gain_minus_no_gain": effect,
        "ci_low": effect_low,
        "ci_high": effect_high,
        "within_trajectory_gain_effect_controlling_event_time": float(controlled_beta[0]),
        "controlled_ci_low": float(controlled_low[0]),
        "controlled_ci_high": float(controlled_high[0]),
        "event_time_coefficient": float(controlled_beta[1]),
        "controlled_within_r_squared": float(controlled_r_squared),
    }
    return per_question, pd.DataFrame(rows), contrast


def bootstrap_auc(
    terminal: pd.DataFrame,
    score_column: str,
    rng: np.random.Generator,
    draws: int,
) -> tuple[float, float, float]:
    estimate = auc_rank(terminal["correct"], terminal[score_column])
    questions = terminal["question_id"].drop_duplicates().to_numpy()
    groups = {question: terminal[terminal["question_id"] == question] for question in questions}
    replicates = np.empty(draws, dtype=float)
    for draw in range(draws):
        selected = rng.choice(questions, size=len(questions), replace=True)
        sample = pd.concat([groups[question] for question in selected], ignore_index=True)
        replicates[draw] = auc_rank(sample["correct"], sample[score_column])
    low, high = percentile_interval(replicates)
    return estimate, low, high


def terminal_analysis(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, dict]:
    terminal = states[states["decision_step"] == states["trajectory_length"]].copy()
    aucs = {}
    for column, label in (("r", "terminal_coverage"), ("margin", "terminal_margin")):
        estimate, low, high = bootstrap_auc(terminal, column, rng, draws)
        aucs[label] = {"auc": estimate, "ci_low": low, "ci_high": high}
    terminal["full_coverage"] = terminal["r"] >= 1 - 1e-12
    terminal["native_positive"] = terminal["margin"] > 0
    rates = {}
    for key, subset in terminal.groupby("full_coverage"):
        rates["full" if key else "incomplete"] = {
            "trajectories": int(len(subset)),
            "correct": int(subset["correct"].sum()),
            "accuracy": float(subset["correct"].mean()),
            "native_positive_rate": float(subset["native_positive"].mean()),
        }
    contrasts = []
    for question_id, subset in terminal.groupby("question_id"):
        if subset["correct"].nunique() < 2:
            continue
        contrasts.append(
            {
                "question_id": question_id,
                "coverage_difference": float(
                    subset.loc[subset["correct"], "r"].mean()
                    - subset.loc[~subset["correct"], "r"].mean()
                ),
                "margin_difference": float(
                    subset.loc[subset["correct"], "margin"].mean()
                    - subset.loc[~subset["correct"], "margin"].mean()
                ),
            }
        )
    contrast_frame = pd.DataFrame(contrasts)
    contrast_summary: dict[str, float | int | None] = {
        "questions_with_both_outcomes": int(len(contrast_frame))
    }
    for metric in ("coverage_difference", "margin_difference"):
        if len(contrast_frame):
            mean, low, high = bootstrap_rows(contrast_frame[metric].to_numpy(), rng, draws)
        else:
            # JSON has no representation for NaN.  A missing contrast is
            # genuinely undefined (no question has both outcomes), so expose
            # it as JSON null instead of relying on Python's non-standard NaN.
            mean = low = high = None
        contrast_summary[metric] = mean
        contrast_summary[f"{metric}_ci_low"] = low
        contrast_summary[f"{metric}_ci_high"] = high
    return terminal, {
        "auc_for_correctness": aucs,
        "terminal_groups": rates,
        "within_question_correct_minus_incorrect": contrast_summary,
    }


def round_effects(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> pd.DataFrame:
    rows: list[dict] = []
    subsets = list(states.groupby("round", sort=False))
    if len(subsets) > 1:
        subsets.append(("Combined", states))
    for label, subset in subsets:
        beta, r_squared = weighted_within_fit(subset)
        low, high = bootstrap_within_fit(subset, rng, draws)
        rows.append(
            {
                "round": label,
                "r_coefficient": float(beta[0]),
                "r_ci_low": float(low[0]),
                "r_ci_high": float(high[0]),
                "tau_coefficient": float(beta[1]),
                "tau_ci_low": float(low[1]),
                "tau_ci_high": float(high[1]),
                "within_r_squared": float(r_squared),
                "questions": int(subset["question_id"].nunique()),
                "states": int(len(subset)),
            }
        )
    return pd.DataFrame(rows)


def sensitivity_effects(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> pd.DataFrame:
    rows = []
    for label, subset in (
        ("All questions", states),
        ("LWW-clean only", states[~states["conflicted"]]),
    ):
        beta, r_squared = weighted_within_fit(subset)
        low, high = bootstrap_within_fit(subset, rng, draws)
        rows.append(
            {
                "subset": label,
                "questions": int(subset["question_id"].nunique()),
                "trajectories": int(subset["run_question"].nunique()),
                "states": int(len(subset)),
                "r_coefficient": float(beta[0]),
                "r_ci_low": float(low[0]),
                "r_ci_high": float(high[0]),
                "tau_coefficient": float(beta[1]),
                "tau_ci_low": float(low[1]),
                "tau_ci_high": float(high[1]),
                "within_r_squared": float(r_squared),
            }
        )
    return pd.DataFrame(rows)


def plot_temporal_metric(
    temporal: pd.DataFrame,
    metric: str,
    color: str,
    ylabel: str,
    output: Path,
    *,
    zero_line: bool = False,
) -> None:
    figure, axis = plt.subplots(figsize=(3.50, 2.50))
    x = temporal["tau"].to_numpy()
    mean = temporal[f"{metric}_mean"].to_numpy()
    low = temporal[f"{metric}_ci_low"].to_numpy()
    high = temporal[f"{metric}_ci_high"].to_numpy()
    axis.fill_between(x, low, high, color=color, alpha=0.13, linewidth=0)
    axis.plot(x, mean, color=color, linewidth=1.8)
    if zero_line:
        axis.axhline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_xlabel("Normalized acquisition step, $t/T$")
    axis.set_ylabel(ylabel)
    axis.set_xlim(0, 1)
    axis.set_xticks(np.linspace(0, 1, 6))
    if metric == "r":
        axis.set_ylim(-0.02, 1.02)
        axis.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis)
    save_figure(figure, output)


def fade_violins(axis: plt.Axes, alpha: float = 0.13) -> None:
    for collection in axis.collections:
        if isinstance(collection, mpl.collections.PolyCollection):
            collection.set_alpha(alpha)
            collection.set_edgecolor("none")


def plot_margin_by_coverage(
    per_question: pd.DataFrame, summary: pd.DataFrame, output: Path, seed: int
) -> None:
    levels = sorted(per_question["r"].unique())
    labels = [f"{value:g}" if value in (0, 1) else f"{value:.2f}" for value in levels]
    lookup = {value: label for value, label in zip(levels, labels)}
    plot_data = per_question.copy()
    plot_data["coverage"] = plot_data["r"].map(lookup)
    figure, axis = plt.subplots(figsize=(4.15, 2.72))
    sns.violinplot(
        data=plot_data,
        x="coverage",
        y="margin",
        order=labels,
        color=RED,
        inner=None,
        cut=0,
        density_norm="width",
        linewidth=0,
        saturation=1,
        ax=axis,
    )
    fade_violins(axis)
    np.random.seed(seed)
    sns.stripplot(
        data=plot_data,
        x="coverage",
        y="margin",
        order=labels,
        color=DARK_RED,
        size=2.0,
        jitter=0.19,
        alpha=0.24,
        linewidth=0,
        native_scale=False,
        ax=axis,
    )
    aligned = summary.set_index("r").loc[levels]
    positions = np.arange(len(levels))
    means = aligned["margin_mean"].to_numpy()
    low = aligned["margin_ci_low"].to_numpy()
    high = aligned["margin_ci_high"].to_numpy()
    axis.errorbar(
        positions,
        means,
        yerr=np.vstack([means - low, high - means]),
        fmt="o",
        color=DARK_RED,
        markerfacecolor=WHITE,
        markeredgewidth=1.1,
        markersize=4.2,
        capsize=2.2,
        elinewidth=1.0,
        zorder=5,
    )
    axis.axhline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_xlabel("Gold-evidence coverage, $R$")
    axis.set_ylabel("Native logit margin, $m$")
    tidy_axis(axis)
    save_figure(figure, output)


def plot_stop_rate(summary: pd.DataFrame, output: Path) -> None:
    figure, axis = plt.subplots(figsize=(3.50, 2.50))
    x = summary["r"].to_numpy()
    mean = summary["stop_rate_mean"].to_numpy()
    low = summary["stop_rate_ci_low"].to_numpy()
    high = summary["stop_rate_ci_high"].to_numpy()
    axis.plot(x, mean, color=RED, linewidth=1.45, zorder=2)
    axis.errorbar(
        x,
        mean,
        yerr=np.vstack([mean - low, high - mean]),
        fmt="o",
        color=RED,
        markerfacecolor=WHITE,
        markeredgewidth=1.05,
        markersize=4.0,
        capsize=2.0,
        elinewidth=0.9,
        zorder=3,
    )
    axis.set_xlabel("Gold-evidence coverage, $R$")
    axis.set_ylabel("Pr(native margin $>0$)")
    axis.set_xlim(-0.02, 1.02)
    axis.set_ylim(-0.02, 1.02)
    axis.set_xticks(np.linspace(0, 1, 5))
    axis.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis)
    save_figure(figure, output)


def plot_event_shift(
    per_question: pd.DataFrame, summary: pd.DataFrame, output: Path, seed: int
) -> None:
    order = ["No gold-evidence gain", "Gold-evidence gain"]
    labels = ["No gain", "Gold-evidence gain"]
    figure, axis = plt.subplots(figsize=(3.50, 2.65))
    sns.violinplot(
        data=per_question,
        x="event",
        y="delta_margin",
        order=order,
        palette={"No gold-evidence gain": GRAY, "Gold-evidence gain": RED},
        hue="event",
        legend=False,
        inner=None,
        cut=0,
        density_norm="width",
        linewidth=0,
        saturation=1,
        ax=axis,
    )
    fade_violins(axis, 0.14)
    np.random.seed(seed)
    sns.stripplot(
        data=per_question,
        x="event",
        y="delta_margin",
        order=order,
        hue="event",
        palette={"No gold-evidence gain": CHARCOAL, "Gold-evidence gain": DARK_RED},
        legend=False,
        size=2.2,
        jitter=0.16,
        alpha=0.26,
        linewidth=0,
        ax=axis,
    )
    summary_indexed = summary.set_index("event")
    for position, event in enumerate(order):
        row = summary_indexed.loc[event]
        axis.errorbar(
            [position],
            [row["delta_margin_mean"]],
            yerr=[[row["delta_margin_mean"] - row["delta_margin_ci_low"]], [row["delta_margin_ci_high"] - row["delta_margin_mean"]]],
            fmt="o",
            color=DARK_RED if position else CHARCOAL,
            markerfacecolor=WHITE,
            markeredgewidth=1.1,
            markersize=4.2,
            capsize=2.2,
            elinewidth=1.0,
            zorder=5,
        )
    axis.axhline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_xticks(range(len(labels)), labels)
    axis.set_xlabel("")
    axis.set_ylabel("Change in native margin, $\Delta m$")
    tidy_axis(axis)
    save_figure(figure, output)


def plot_terminal_map(terminal: pd.DataFrame, output: Path, seed: int) -> None:
    levels = sorted(terminal["r"].unique())
    position = {value: index for index, value in enumerate(levels)}
    rng = np.random.default_rng(seed)
    figure, axis = plt.subplots(figsize=(4.15, 2.75))
    for correct, color, marker, label, zorder in (
        (False, GRAY, "o", "Incorrect", 2),
        (True, RED, "D", "Correct", 3),
    ):
        subset = terminal[terminal["correct"] == correct]
        x = subset["r"].map(position).to_numpy(dtype=float)
        x += rng.uniform(-0.13, 0.13, size=len(x))
        if correct:
            axis.scatter(x, subset["margin"], s=13, color=color, marker=marker, alpha=0.56, linewidth=0, label=label, zorder=zorder)
        else:
            axis.scatter(x, subset["margin"], s=13, facecolors=WHITE, edgecolors=color, marker=marker, alpha=0.62, linewidth=0.58, label=label, zorder=zorder)
    axis.axhline(0, color=CHARCOAL, linewidth=0.8, linestyle=(0, (3, 3)), zorder=0)
    axis.set_xticks(range(len(levels)), [f"{value:g}" if value in (0, 1) else f"{value:.2f}" for value in levels])
    axis.set_xlabel("Terminal gold-evidence coverage, $R_T$")
    axis.set_ylabel("Terminal native margin, $m_T$")
    axis.legend(loc="lower right", ncols=2, handletextpad=0.4, columnspacing=1.0)
    tidy_axis(axis)
    save_figure(figure, output)


def plot_round_effects(effects: pd.DataFrame, output: Path) -> None:
    figure, axis = plt.subplots(figsize=(3.50, max(2.15, 0.43 * len(effects) + 0.70)))
    display = effects.iloc[::-1].reset_index(drop=True)
    positions = np.arange(len(display))
    colors = [DARK_RED if label == "Combined" else TEAL for label in display["round"]]
    for position, (_, row), color in zip(positions, display.iterrows(), colors):
        axis.plot([row["r_ci_low"], row["r_ci_high"]], [position, position], color=color, linewidth=1.35)
        axis.scatter([row["r_coefficient"]], [position], s=25, color=color, edgecolor=WHITE, linewidth=0.6, zorder=3)
    axis.axvline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_yticks(positions, display["round"])
    axis.set_xlabel("Coverage effect on native margin\n(controlling acquisition time)")
    axis.set_ylabel("")
    tidy_axis(axis, ygrid=False)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    save_figure(figure, output)


def plot_controlled_drivers(effects: pd.DataFrame, output: Path) -> None:
    row = effects.iloc[-1]
    labels = ["Evidence coverage, $R$", "Acquisition time, $t/T$"]
    means = np.asarray([row["r_coefficient"], row["tau_coefficient"]], dtype=float)
    lows = np.asarray([row["r_ci_low"], row["tau_ci_low"]], dtype=float)
    highs = np.asarray([row["r_ci_high"], row["tau_ci_high"]], dtype=float)
    colors = [TEAL, RED]
    figure, axis = plt.subplots(figsize=(3.50, 2.12))
    positions = np.asarray([1, 0])
    for position, mean, low, high, color in zip(positions, means, lows, highs, colors):
        axis.plot([low, high], [position, position], color=color, linewidth=1.4)
        axis.scatter([mean], [position], s=27, color=color, edgecolor=WHITE, linewidth=0.6, zorder=3)
    axis.axvline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_yticks(positions, labels)
    axis.set_xlabel("Change in native margin over the unit range\n(mutually controlled)")
    axis.set_ylabel("")
    tidy_axis(axis, ygrid=False)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    save_figure(figure, output)


def plot_terminal_auc(terminal_summary: dict, output: Path) -> None:
    aucs = terminal_summary["auc_for_correctness"]
    labels = ["Gold coverage, $R_T$", "Native margin, $m_T$"]
    keys = ["terminal_coverage", "terminal_margin"]
    positions = np.asarray([1, 0])
    colors = [TEAL, RED]
    figure, axis = plt.subplots(figsize=(3.50, 2.12))
    for position, key, color in zip(positions, keys, colors):
        item = aucs[key]
        axis.plot([item["ci_low"], item["ci_high"]], [position, position], color=color, linewidth=1.4)
        axis.scatter([item["auc"]], [position], s=27, color=color, edgecolor=WHITE, linewidth=0.6, zorder=3)
    axis.axvline(0.5, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_yticks(positions, labels)
    axis.set_xlim(0.45, 1.0)
    axis.set_xticks(np.linspace(0.5, 1.0, 6))
    axis.set_xlabel("Terminal correctness discrimination (AUC)")
    axis.set_ylabel("")
    tidy_axis(axis, ygrid=False)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    save_figure(figure, output)


def plot_within_question_outcome(terminal_summary: dict, output: Path) -> None:
    item = terminal_summary["within_question_correct_minus_incorrect"]
    if not item["questions_with_both_outcomes"]:
        return
    labels = ["Gold coverage, $R_T$", "Native margin, $m_T$"]
    prefixes = ["coverage_difference", "margin_difference"]
    positions = np.asarray([1, 0])
    colors = [TEAL, RED]
    figure, axis = plt.subplots(figsize=(3.50, 2.12))
    for position, prefix, color in zip(positions, prefixes, colors):
        mean = item[prefix]
        low = item[f"{prefix}_ci_low"]
        high = item[f"{prefix}_ci_high"]
        axis.plot([low, high], [position, position], color=color, linewidth=1.4)
        axis.scatter([mean], [position], s=27, color=color, edgecolor=WHITE, linewidth=0.6, zorder=3)
    axis.axvline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_yticks(positions, labels)
    axis.set_xlabel("Correct minus incorrect trajectory\n(within the same question)")
    axis.set_ylabel("")
    tidy_axis(axis, ygrid=False)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    save_figure(figure, output)


def plot_sensitivity(effects: pd.DataFrame, output: Path) -> None:
    display = effects.iloc[::-1].reset_index(drop=True)
    positions = np.arange(len(display))
    colors = [TEAL if label == "LWW-clean only" else DARK_RED for label in display["subset"]]
    figure, axis = plt.subplots(figsize=(3.50, 2.12))
    for position, (_, row), color in zip(positions, display.iterrows(), colors):
        axis.plot([row["r_ci_low"], row["r_ci_high"]], [position, position], color=color, linewidth=1.4)
        axis.scatter([row["r_coefficient"]], [position], s=27, color=color, edgecolor=WHITE, linewidth=0.6, zorder=3)
    axis.axvline(0, color=GRAY, linewidth=0.75, linestyle=(0, (3, 3)), zorder=0)
    axis.set_yticks(positions, display["subset"])
    axis.set_xlabel("Coverage effect on native margin\n(controlling acquisition time)")
    axis.set_ylabel("")
    tidy_axis(axis, ygrid=False)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.72)
    save_figure(figure, output)


def write_json(path: Path, document: dict) -> None:
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--round", action="append", type=parse_round, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bootstrap-draws", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()

    output = args.output_dir.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    configure_style()
    raw, validation = load_and_validate(args.round)
    states = collapse_replicas(raw)
    rng = np.random.default_rng(args.seed)

    coverage_questions, coverage_summary = question_balanced_coverage(states, rng, args.bootstrap_draws)
    temporal = temporal_curves(states, rng, args.bootstrap_draws)
    event_questions, event_summary, event_contrast = event_analysis(states, rng, args.bootstrap_draws)
    terminal, terminal_summary = terminal_analysis(states, rng, args.bootstrap_draws)
    effects = round_effects(states, rng, args.bootstrap_draws)
    sensitivity = sensitivity_effects(states, rng, args.bootstrap_draws)

    beta, within_r_squared = weighted_within_fit(states)
    beta_low, beta_high = bootstrap_within_fit(states, rng, args.bootstrap_draws)
    pooled_pearson = pearson(states["r"], states["margin"])
    pooled_spearman = pearson(rank_average(states["r"]), rank_average(states["margin"]))
    centered_r = states["r"] - states.groupby("run_question")["r"].transform("mean")
    centered_margin = states["margin"] - states.groupby("run_question")["margin"].transform("mean")
    within_pearson = pearson(centered_r, centered_margin)

    premature = states[states["r"] < 1 - 1e-12]
    complete = states[states["r"] >= 1 - 1e-12]
    summary = {
        "analysis_version": 2,
        "primary_sufficiency_readout": "native_logit_margin = log p(sufficient) - log p(insufficient)",
        "decision_rule": "native sufficient iff native_logit_margin > 0",
        "weighting": "replicas collapsed within state; repeated coverage states collapsed within trajectory; rounds averaged within benchmark question; confidence intervals bootstrap benchmark questions",
        "bootstrap": {"draws": args.bootstrap_draws, "seed": args.seed, "interval": "percentile 95%"},
        "validation": validation,
        "sample": {
            "rounds": int(states["round"].nunique()),
            "benchmark_questions": int(states["question_id"].nunique()),
            "independent_trajectories": int(states["run_question"].nunique()),
            "states": int(len(states)),
            "state_replica_rows": int(len(raw)),
        },
        "replica_stability": {
            "native_decision_disagreement_states": int((states["positive_replicas"] == 0.5).sum()),
            "native_decision_disagreement_rate": float((states["positive_replicas"] == 0.5).mean()),
            "median_margin_sd": float(states["replica_margin_sd"].median()),
            "max_margin_sd": float(states["replica_margin_sd"].max()),
        },
        "r_s_association": {
            "pooled_pearson": pooled_pearson,
            "pooled_spearman": pooled_spearman,
            "within_trajectory_pearson": within_pearson,
            "question_balanced_within_regression": {
                "r_coefficient_controlling_tau": float(beta[0]),
                "r_ci_low": float(beta_low[0]),
                "r_ci_high": float(beta_high[0]),
                "tau_coefficient_controlling_r": float(beta[1]),
                "tau_ci_low": float(beta_low[1]),
                "tau_ci_high": float(beta_high[1]),
                "within_r_squared": float(within_r_squared),
            },
        },
        "evidence_gain_event": event_contrast,
        "terminal": terminal_summary,
        "lww_conflict_sensitivity": sensitivity.to_dict(orient="records"),
        "mismatch_states": {
            "incomplete_coverage_states": int(len(premature)),
            "positive_native_margin_while_incomplete": int(premature["native_positive"].sum()),
            "positive_rate_while_incomplete": float(premature["native_positive"].mean()),
            "full_coverage_states": int(len(complete)),
            "nonpositive_native_margin_at_full_coverage": int((~complete["native_positive"]).sum()),
            "nonpositive_rate_at_full_coverage": float((~complete["native_positive"]).mean()),
        },
    }

    states.to_csv(output / "states-collapsed.csv", index=False)
    coverage_questions.to_csv(output / "coverage-question-balanced.csv", index=False)
    coverage_summary.to_csv(output / "coverage-summary.csv", index=False)
    temporal.to_csv(output / "temporal-curves.csv", index=False)
    event_questions.to_csv(output / "event-question-balanced.csv", index=False)
    event_summary.to_csv(output / "event-summary.csv", index=False)
    terminal.to_csv(output / "terminal-states.csv", index=False)
    effects.to_csv(output / "round-effects.csv", index=False)
    sensitivity.to_csv(output / "sensitivity-effects.csv", index=False)
    write_json(output / "analysis-summary.json", summary)

    plot_temporal_metric(temporal, "r", TEAL, "Gold-evidence coverage, $R$", output / "01-coverage-over-acquisition")
    plot_temporal_metric(temporal, "margin", RED, "Native logit margin, $m$", output / "02-margin-over-acquisition", zero_line=True)
    plot_margin_by_coverage(coverage_questions, coverage_summary, output / "03-margin-by-coverage", args.seed)
    plot_stop_rate(coverage_summary, output / "04-native-stop-rate-by-coverage")
    plot_event_shift(event_questions, event_summary, output / "05-margin-shift-at-evidence-gain", args.seed)
    plot_terminal_map(terminal, output / "06-terminal-state-map", args.seed)
    plot_round_effects(effects, output / "07-replication-controlled-effect")
    plot_controlled_drivers(effects, output / "08-controlled-drivers")
    plot_terminal_auc(terminal_summary, output / "09-terminal-correctness-auc")
    plot_sensitivity(sensitivity, output / "10-lww-clean-sensitivity")

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
