#!/usr/bin/env python3
"""Create publication-style exploratory figures for Picorer sufficiency dynamics."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


CARNEGIE_RED = "#C41230"
SKIBO_RED = "#941120"
BLACK = "#000000"
IRON_GRAY = "#6D6E71"
STEEL_GRAY = "#E0E0E0"
WEAVER_BLUE = "#182C4B"
WHITE = "#FFFFFF"

R_LEVELS = np.array([0.0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1.0])
R_LABELS = ["0", "0.25", "0.33", "0.50", "0.67", "0.75", "1"]


def configure_style() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Helvetica", "Arial", "DejaVu Sans"],
            "font.size": 8.5,
            "axes.titlesize": 9.5,
            "axes.titleweight": "bold",
            "axes.labelsize": 8.5,
            "axes.linewidth": 0.7,
            "axes.edgecolor": BLACK,
            "axes.facecolor": WHITE,
            "figure.facecolor": WHITE,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "xtick.major.width": 0.7,
            "ytick.major.width": 0.7,
            "xtick.major.size": 3,
            "ytick.major.size": 3,
            "legend.fontsize": 7.5,
            "legend.frameon": False,
            "grid.color": STEEL_GRAY,
            "grid.linewidth": 0.55,
            "grid.alpha": 0.65,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "savefig.facecolor": WHITE,
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.04,
        }
    )


def tidy_axis(axis: plt.Axes, *, grid: bool = True) -> None:
    axis.spines["top"].set_visible(False)
    axis.spines["right"].set_visible(False)
    if grid:
        axis.grid(axis="y", zorder=0)
    axis.tick_params(direction="out")


def panel_label(axis: plt.Axes, label: str) -> None:
    axis.text(
        -0.14,
        1.09,
        label,
        transform=axis.transAxes,
        fontsize=11,
        fontweight="bold",
        va="top",
        ha="left",
    )


def bootstrap_mean_ci(
    values: np.ndarray, rng: np.random.Generator, draws: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bootstrap row clusters and return mean, 2.5%, and 97.5%."""
    values = np.asarray(values, dtype=float)
    if values.ndim == 1:
        values = values[:, None]
    count = values.shape[0]
    mean = np.nanmean(values, axis=0)
    if count == 1:
        return mean, mean.copy(), mean.copy()
    estimates = np.empty((draws, values.shape[1]), dtype=float)
    for draw in range(draws):
        sample = rng.integers(0, count, size=count)
        estimates[draw] = np.nanmean(values[sample], axis=0)
    low, high = np.nanpercentile(estimates, [2.5, 97.5], axis=0)
    return mean, low, high


def wilson_interval(successes: int, total: int) -> tuple[float, float]:
    if total == 0:
        return math.nan, math.nan
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    half = (
        z
        * math.sqrt(
            proportion * (1 - proportion) / total + z * z / (4 * total * total)
        )
        / denominator
    )
    return center - half, center + half


def collapse_replicas(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    frame["native_positive"] = (frame["native_logit_margin"] > 0).astype(float)
    frame["explicit_positive"] = (
        frame["j_sufficient_fraction"] > 0.5
    ).astype(float)
    return (
        frame.groupby(["question_id", "decision_step"], as_index=False)
        .agg(
            r=("gold_coverage_r", "first"),
            tau=("normalized_progress", "first"),
            trajectory_length=("decision_state_count", "first"),
            j=("j_sufficient_fraction", "mean"),
            native_s=("native_sufficient_likelihood", "mean"),
            native_margin=("native_logit_margin", "mean"),
            native_decision_rate=("native_positive", "mean"),
            explicit_decision_rate=("explicit_positive", "mean"),
            correct=("final_correct", "first"),
            conflicted=("official_gold_lww_conflicted", "first"),
        )
        .sort_values(["question_id", "decision_step"])
    )


def temporal_curves(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]]:
    grid = np.linspace(0, 1, 51)
    questions = list(states["question_id"].drop_duplicates())
    metric_arrays = {
        "r": np.empty((len(questions), len(grid))),
        "j": np.empty((len(questions), len(grid))),
        "native_s": np.empty((len(questions), len(grid))),
    }
    for index, question_id in enumerate(questions):
        subset = states[states["question_id"] == question_id].sort_values(
            "decision_step"
        )
        tau = subset["tau"].to_numpy(dtype=float)
        for metric in ("j", "native_s"):
            values = subset[metric].to_numpy(dtype=float)
            metric_arrays[metric][index] = np.interp(
                grid, tau, values, left=values[0], right=values[-1]
            )
        r_values = subset["r"].to_numpy(dtype=float)
        step_indices = np.searchsorted(tau, grid, side="right") - 1
        step_indices = np.clip(step_indices, 0, len(r_values) - 1)
        metric_arrays["r"][index] = r_values[step_indices]

    estimates = {
        metric: bootstrap_mean_ci(values, rng, draws)
        for metric, values in metric_arrays.items()
    }
    output = pd.DataFrame({"normalized_progress": grid})
    for metric, (mean, low, high) in estimates.items():
        output[f"{metric}_mean"] = mean
        output[f"{metric}_ci_low"] = low
        output[f"{metric}_ci_high"] = high
    return output, estimates


def coverage_conditioned(
    states: pd.DataFrame, rng: np.random.Generator, draws: int
) -> pd.DataFrame:
    within_question = (
        states.groupby(["question_id", "r"], as_index=False)
        .agg(
            j=("j", "mean"),
            native_s=("native_s", "mean"),
            native_margin=("native_margin", "mean"),
            native_decision_rate=("native_decision_rate", "mean"),
            explicit_decision_rate=("explicit_decision_rate", "mean"),
        )
        .sort_values(["r", "question_id"])
    )
    rows = []
    for r_value in R_LEVELS:
        subset = within_question[np.isclose(within_question["r"], r_value)]
        row: dict[str, float | int] = {
            "r": float(r_value),
            "questions": int(len(subset)),
        }
        for metric in (
            "j",
            "native_s",
            "native_margin",
            "native_decision_rate",
            "explicit_decision_rate",
        ):
            mean, low, high = bootstrap_mean_ci(
                subset[metric].to_numpy(dtype=float), rng, draws
            )
            row[f"{metric}_mean"] = float(mean[0])
            row[f"{metric}_ci_low"] = float(low[0])
            row[f"{metric}_ci_high"] = float(high[0])
        rows.append(row)
    return pd.DataFrame(rows)


def terminal_accuracy(states: pd.DataFrame) -> pd.DataFrame:
    terminal = states[
        states["decision_step"] == states["trajectory_length"]
    ].copy()
    rows = []
    for r_value in R_LEVELS:
        subset = terminal[np.isclose(terminal["r"], r_value)]
        total = len(subset)
        successes = int(subset["correct"].sum())
        low, high = wilson_interval(successes, total)
        rows.append(
            {
                "r": float(r_value),
                "questions": total,
                "correct": successes,
                "accuracy": successes / total if total else math.nan,
                "ci_low": low,
                "ci_high": high,
            }
        )
    return pd.DataFrame(rows)


def agreement_and_composition(
    frame: pd.DataFrame, rng: np.random.Generator, draws: int
) -> tuple[pd.DataFrame, pd.DataFrame]:
    data = frame.copy()
    data["explicit_positive"] = data["j_sufficient_fraction"] > 0.5
    data["native_positive"] = data["native_logit_margin"] > 0
    data["agreement"] = (
        data["explicit_positive"] == data["native_positive"]
    ).astype(float)
    data["category"] = np.select(
        [
            ~data["explicit_positive"] & ~data["native_positive"],
            data["explicit_positive"] & ~data["native_positive"],
            ~data["explicit_positive"] & data["native_positive"],
        ],
        ["both_insufficient", "j_only", "native_only"],
        default="both_sufficient",
    )

    question_agreement = (
        data.groupby(["question_id", "gold_coverage_r"], as_index=False)[
            "agreement"
        ]
        .mean()
        .rename(columns={"gold_coverage_r": "r"})
    )
    agreement_rows = []
    for r_value in R_LEVELS:
        subset = question_agreement[
            np.isclose(question_agreement["r"], r_value)
        ]
        mean, low, high = bootstrap_mean_ci(
            subset["agreement"].to_numpy(dtype=float), rng, draws
        )
        agreement_rows.append(
            {
                "r": float(r_value),
                "questions": len(subset),
                "agreement": float(mean[0]),
                "ci_low": float(low[0]),
                "ci_high": float(high[0]),
            }
        )

    categories = [
        "both_insufficient",
        "j_only",
        "native_only",
        "both_sufficient",
    ]
    counts = (
        data.groupby(["question_id", "gold_coverage_r", "category"])
        .size()
        .rename("count")
        .reset_index()
    )
    totals = counts.groupby(["question_id", "gold_coverage_r"])["count"].transform(
        "sum"
    )
    counts["fraction"] = counts["count"] / totals
    per_question = (
        counts.pivot_table(
            index=["question_id", "gold_coverage_r"],
            columns="category",
            values="fraction",
            fill_value=0,
        )
        .reindex(columns=categories, fill_value=0)
        .reset_index()
        .rename(columns={"gold_coverage_r": "r"})
    )
    composition = (
        per_question.groupby("r", as_index=False)[categories].mean().sort_values("r")
    )
    return pd.DataFrame(agreement_rows), composition


def plot_overview(
    states: pd.DataFrame,
    temporal: pd.DataFrame,
    conditioned: pd.DataFrame,
    accuracy: pd.DataFrame,
    output: Path,
) -> None:
    figure, axes = plt.subplots(2, 2, figsize=(7.2, 5.8))
    axis_a, axis_b, axis_c, axis_d = axes.flat

    series = [
        ("r", "Gold coverage $R$", BLACK, "-", "o"),
        ("j", "Explicit judgment $J$", WEAVER_BLUE, "--", "s"),
        ("native_s", "Native likelihood $S$", CARNEGIE_RED, "-", "^"),
    ]
    x = temporal["normalized_progress"].to_numpy()
    for metric, label, color, linestyle, marker in series:
        mean = temporal[f"{metric}_mean"].to_numpy()
        low = temporal[f"{metric}_ci_low"].to_numpy()
        high = temporal[f"{metric}_ci_high"].to_numpy()
        axis_a.fill_between(x, low, high, color=color, alpha=0.11, linewidth=0)
        axis_a.plot(
            x,
            mean,
            label=label,
            color=color,
            linestyle=linestyle,
            linewidth=1.5,
            marker=marker,
            markevery=10,
            markersize=3.2,
        )
    axis_a.set(
        title="Acquisition dynamics",
        xlabel="Normalized acquisition progress, $t/T$",
        ylabel="Mean value",
        xlim=(0, 1),
        ylim=(-0.02, 1.02),
    )
    axis_a.set_xticks(np.linspace(0, 1, 6))
    axis_a.set_yticks(np.linspace(0, 1, 6))
    axis_a.legend(loc="lower right", handlelength=2.5)
    tidy_axis(axis_a)
    panel_label(axis_a, "A")

    x_positions = np.arange(len(conditioned))
    conditioned_series = [
        ("j", "Explicit $J$", WEAVER_BLUE, "s", "--"),
        ("native_s", "Native $S$", CARNEGIE_RED, "^", "-"),
        (
            "native_decision_rate",
            "Native decision ($\Delta>0$)",
            SKIBO_RED,
            "D",
            ":",
        ),
    ]
    for metric, label, color, marker, linestyle in conditioned_series:
        mean = conditioned[f"{metric}_mean"].to_numpy()
        low = conditioned[f"{metric}_ci_low"].to_numpy()
        high = conditioned[f"{metric}_ci_high"].to_numpy()
        axis_b.errorbar(
            x_positions,
            mean,
            yerr=np.maximum(0, np.vstack([mean - low, high - mean])),
            label=label,
            color=color,
            marker=marker,
            linestyle=linestyle,
            linewidth=1.25,
            markersize=4,
            capsize=2,
            elinewidth=0.8,
        )
    axis_b.set(
        title="Sufficiency conditioned on evidence",
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Question-averaged value",
        ylim=(-0.02, 1.02),
    )
    axis_b.set_xticks(x_positions, R_LABELS)
    axis_b.set_yticks(np.linspace(0, 1, 6))
    axis_b.legend(loc="lower right", handlelength=2.3)
    tidy_axis(axis_b)
    panel_label(axis_b, "B")

    within_question = (
        states.groupby(["question_id", "r"], as_index=False)["native_margin"]
        .mean()
        .sort_values("r")
    )
    margin_groups = [
        within_question[np.isclose(within_question["r"], level)][
            "native_margin"
        ].to_numpy()
        for level in R_LEVELS
    ]
    boxes = axis_c.boxplot(
        margin_groups,
        positions=x_positions,
        widths=0.58,
        patch_artist=True,
        showfliers=False,
        medianprops={"color": BLACK, "linewidth": 1.1},
        whiskerprops={"color": IRON_GRAY, "linewidth": 0.8},
        capprops={"color": IRON_GRAY, "linewidth": 0.8},
        boxprops={"edgecolor": CARNEGIE_RED, "linewidth": 0.9},
    )
    for box in boxes["boxes"]:
        box.set_facecolor(CARNEGIE_RED)
        box.set_alpha(0.16)
    jitter_rng = np.random.default_rng(1701)
    for index, values in enumerate(margin_groups):
        jitter = jitter_rng.normal(index, 0.055, size=len(values))
        axis_c.scatter(
            jitter,
            values,
            s=8,
            facecolors=WHITE,
            edgecolors=CARNEGIE_RED,
            linewidths=0.45,
            alpha=0.55,
            zorder=2,
        )
    axis_c.axhline(0, color=BLACK, linewidth=0.8, linestyle="--", zorder=1)
    axis_c.set(
        title="Native finish margin",
        xlabel="Gold-evidence coverage, $R$",
        ylabel="$\Delta=\log p(\mathrm{suff.})-\log p(\mathrm{insuff.})$",
    )
    axis_c.set_xticks(x_positions, R_LABELS)
    axis_c.text(
        0.01,
        0.96,
        "$\Delta>0$ predicts sufficient",
        transform=axis_c.transAxes,
        color=IRON_GRAY,
        fontsize=7.2,
        va="top",
    )
    tidy_axis(axis_c)
    panel_label(axis_c, "C")

    rates = accuracy["accuracy"].to_numpy(dtype=float)
    low = accuracy["ci_low"].to_numpy(dtype=float)
    high = accuracy["ci_high"].to_numpy(dtype=float)
    colors = [IRON_GRAY] * (len(rates) - 1) + [CARNEGIE_RED]
    axis_d.bar(
        x_positions,
        rates,
        width=0.68,
        color=colors,
        alpha=0.92,
        zorder=2,
    )
    axis_d.errorbar(
        x_positions,
        rates,
        yerr=np.maximum(0, np.vstack([rates - low, high - rates])),
        fmt="none",
        color=BLACK,
        capsize=2,
        linewidth=0.8,
        zorder=3,
    )
    for position, row in accuracy.iterrows():
        axis_d.text(
            position,
            min(1.03, float(row["ci_high"]) + 0.04),
            f'n={int(row["questions"])}',
            ha="center",
            va="bottom",
            fontsize=7,
            color=IRON_GRAY,
        )
    axis_d.set(
        title="Final answer accuracy",
        xlabel="Terminal gold-evidence coverage, $R_T$",
        ylabel="Official accuracy",
        ylim=(0, 1.12),
    )
    axis_d.set_xticks(x_positions, R_LABELS)
    axis_d.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis_d)
    panel_label(axis_d, "D")

    figure.text(
        0.01,
        0.006,
        "A: trajectory-wise normalization; B–C: states are averaged within question and coverage before pooling. "
        "Bands/error bars: 95% question-level bootstrap CI. D: Wilson 95% CI.",
        fontsize=6.8,
        color=IRON_GRAY,
    )
    figure.subplots_adjust(left=0.09, right=0.99, top=0.95, bottom=0.11, wspace=0.31, hspace=0.40)
    figure.savefig(output.with_suffix(".pdf"))
    figure.savefig(output.with_suffix(".png"), dpi=300)
    plt.close(figure)


def plot_proxy_diagnostics(
    frame: pd.DataFrame,
    agreement: pd.DataFrame,
    composition: pd.DataFrame,
    output: Path,
) -> None:
    figure, axes = plt.subplots(2, 2, figsize=(7.2, 5.8))
    axis_a, axis_b, axis_c, axis_d = axes.flat

    pair = frame.pivot_table(
        index=["question_id", "decision_step"],
        columns="replica",
        values=["j_sufficient_fraction", "native_logit_margin"],
        aggfunc="first",
    )
    j1 = pair[("j_sufficient_fraction", "qwen-r1")].to_numpy()
    j2 = pair[("j_sufficient_fraction", "qwen-r2")].to_numpy()
    j_corr = float(np.corrcoef(j1, j2)[0, 1])
    j_agree = float(np.mean((j1 > 0.5) == (j2 > 0.5)))
    axis_a.scatter(
        j1,
        j2,
        s=10,
        facecolors="none",
        edgecolors=WEAVER_BLUE,
        linewidths=0.5,
        alpha=0.35,
    )
    axis_a.plot([0, 1], [0, 1], color=IRON_GRAY, linewidth=0.8, linestyle="--")
    axis_a.axhline(0.5, color=STEEL_GRAY, linewidth=0.7)
    axis_a.axvline(0.5, color=STEEL_GRAY, linewidth=0.7)
    axis_a.set(
        title="Explicit judgment reproducibility",
        xlabel="$J$ — replica 1",
        ylabel="$J$ — replica 2",
        xlim=(-0.02, 1.02),
        ylim=(-0.02, 1.02),
    )
    axis_a.text(
        0.04,
        0.92,
        f"Pearson $r$={j_corr:.2f}\nBinary agreement={j_agree:.2f}",
        transform=axis_a.transAxes,
        va="top",
        fontsize=7.4,
    )
    tidy_axis(axis_a, grid=False)
    panel_label(axis_a, "A")

    m1 = pair[("native_logit_margin", "qwen-r1")].to_numpy()
    m2 = pair[("native_logit_margin", "qwen-r2")].to_numpy()
    m_corr = float(np.corrcoef(m1, m2)[0, 1])
    m_agree = float(np.mean((m1 > 0) == (m2 > 0)))
    limit = math.ceil(max(np.max(np.abs(m1)), np.max(np.abs(m2))))
    axis_b.scatter(
        m1,
        m2,
        s=10,
        facecolors="none",
        edgecolors=CARNEGIE_RED,
        linewidths=0.5,
        alpha=0.35,
    )
    axis_b.plot(
        [-limit, limit],
        [-limit, limit],
        color=IRON_GRAY,
        linewidth=0.8,
        linestyle="--",
    )
    axis_b.axhline(0, color=STEEL_GRAY, linewidth=0.7)
    axis_b.axvline(0, color=STEEL_GRAY, linewidth=0.7)
    axis_b.set(
        title="Native margin reproducibility",
        xlabel="$\Delta$ — replica 1",
        ylabel="$\Delta$ — replica 2",
        xlim=(-limit, limit),
        ylim=(-limit, limit),
    )
    axis_b.text(
        0.04,
        0.92,
        f"Pearson $r$={m_corr:.2f}\nSign agreement={m_agree:.2f}",
        transform=axis_b.transAxes,
        va="top",
        fontsize=7.4,
    )
    tidy_axis(axis_b, grid=False)
    panel_label(axis_b, "B")

    positions = np.arange(len(agreement))
    values = agreement["agreement"].to_numpy()
    low = agreement["ci_low"].to_numpy()
    high = agreement["ci_high"].to_numpy()
    axis_c.errorbar(
        positions,
        values,
        yerr=np.maximum(0, np.vstack([values - low, high - values])),
        color=CARNEGIE_RED,
        marker="o",
        markersize=4,
        linewidth=1.35,
        capsize=2,
    )
    axis_c.axhline(0.5, color=IRON_GRAY, linewidth=0.8, linestyle="--")
    for position, row in agreement.iterrows():
        axis_c.text(
            position,
            min(1.025, float(row["ci_high"]) + 0.035),
            f'n={int(row["questions"])}',
            ha="center",
            va="bottom",
            fontsize=7,
            color=IRON_GRAY,
        )
    axis_c.set(
        title="Explicit–native decision agreement",
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Agreement rate",
        ylim=(0, 1.10),
    )
    axis_c.set_xticks(positions, R_LABELS)
    axis_c.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis_c)
    panel_label(axis_c, "C")

    categories = [
        ("both_insufficient", "Both insufficient", STEEL_GRAY),
        ("j_only", "$J$ sufficient only", WEAVER_BLUE),
        ("native_only", "Native sufficient only", CARNEGIE_RED),
        ("both_sufficient", "Both sufficient", IRON_GRAY),
    ]
    bottom = np.zeros(len(composition))
    for column, label, color in categories:
        values = composition[column].to_numpy()
        axis_d.bar(
            positions,
            values,
            bottom=bottom,
            width=0.72,
            color=color,
            label=label,
            zorder=2,
        )
        bottom += values
    axis_d.set(
        title="Decision composition",
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Question-averaged fraction",
        ylim=(0, 1),
    )
    axis_d.set_xticks(positions, R_LABELS)
    axis_d.set_yticks(np.linspace(0, 1, 6))
    axis_d.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.23),
        ncol=2,
        columnspacing=0.8,
        handlelength=1.2,
    )
    tidy_axis(axis_d)
    panel_label(axis_d, "D")

    figure.text(
        0.01,
        0.006,
        "Explicit decision: $J>0.5$. Native decision: $\Delta>0$ (not $S>0.5$). "
        "C–D average repeated states within each question–coverage pair before pooling.",
        fontsize=6.8,
        color=IRON_GRAY,
    )
    figure.subplots_adjust(left=0.09, right=0.99, top=0.95, bottom=0.18, wspace=0.31, hspace=0.42)
    figure.savefig(output.with_suffix(".pdf"))
    figure.savefig(output.with_suffix(".png"), dpi=300)
    plt.close(figure)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bootstrap-draws", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()

    configure_style()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    frame = pd.read_csv(args.input)
    states = collapse_replicas(frame)
    rng = np.random.default_rng(args.seed)

    temporal, _ = temporal_curves(states, rng, args.bootstrap_draws)
    conditioned = coverage_conditioned(states, rng, args.bootstrap_draws)
    accuracy = terminal_accuracy(states)
    agreement, composition = agreement_and_composition(
        frame, rng, args.bootstrap_draws
    )

    temporal.to_csv(args.output_dir / "temporal-curve.csv", index=False)
    conditioned.to_csv(args.output_dir / "coverage-conditioned.csv", index=False)
    accuracy.to_csv(args.output_dir / "terminal-accuracy.csv", index=False)
    agreement.to_csv(args.output_dir / "proxy-agreement-by-coverage.csv", index=False)
    composition.to_csv(
        args.output_dir / "proxy-composition-by-coverage.csv", index=False
    )

    plot_overview(
        states,
        temporal,
        conditioned,
        accuracy,
        args.output_dir / "sufficiency-dynamics-overview",
    )
    plot_proxy_diagnostics(
        frame,
        agreement,
        composition,
        args.output_dir / "proxy-diagnostics",
    )

    summary = {
        "schema_version": 1,
        "input": str(args.input.resolve()),
        "states": len(states),
        "questions": int(states["question_id"].nunique()),
        "state_replica_rows": len(frame),
        "bootstrap_draws": args.bootstrap_draws,
        "bootstrap_unit": "question",
        "seed": args.seed,
        "native_binary_rule": "native_logit_margin > 0",
        "explicit_binary_rule": "j_sufficient_fraction > 0.5",
        "coverage_conditioning": (
            "average states within each question and exact R level, then average questions"
        ),
        "temporal_aggregation": (
            "interpolate each trajectory to a common normalized-progress grid, then average questions"
        ),
        "brand_palette": {
            "Carnegie Red": CARNEGIE_RED,
            "Black": BLACK,
            "Iron Gray": IRON_GRAY,
            "Steel Gray": STEEL_GRAY,
            "Weaver Blue": WEAVER_BLUE,
        },
    }
    (args.output_dir / "figure-metadata.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
