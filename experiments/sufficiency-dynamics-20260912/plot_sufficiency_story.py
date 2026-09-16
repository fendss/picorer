#!/usr/bin/env python3
"""Render message-first, paper-ready figures for the sufficiency experiment."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from plot_sufficiency_dynamics import (
    BLACK,
    CARNEGIE_RED,
    IRON_GRAY,
    R_LABELS,
    SKIBO_RED,
    STEEL_GRAY,
    WEAVER_BLUE,
    WHITE,
    agreement_and_composition,
    collapse_replicas,
    configure_style,
    coverage_conditioned,
    temporal_curves,
    terminal_accuracy,
    tidy_axis,
    wilson_interval,
)


PALE_RED = "#E8B7BF"
PALE_BLUE = "#AEBACA"
LIGHT_GRAY = "#F1F1F1"


def story_style() -> None:
    configure_style()
    mpl.rcParams.update(
        {
            "font.size": 8.2,
            "axes.titlesize": 9.4,
            "axes.titleweight": "bold",
            "axes.labelsize": 8.2,
            "xtick.labelsize": 7.3,
            "ytick.labelsize": 7.3,
            "legend.fontsize": 7.1,
            "axes.titlepad": 8,
        }
    )


def panel_message(axis: plt.Axes, label: str, message: str) -> None:
    axis.text(
        -0.15,
        1.10,
        label,
        transform=axis.transAxes,
        fontsize=10.8,
        fontweight="bold",
        ha="left",
        va="top",
    )
    axis.set_title(message, loc="left")


def add_top_rule(figure: plt.Figure) -> None:
    rule = mpl.lines.Line2D(
        [0.025, 0.975],
        [0.975, 0.975],
        transform=figure.transFigure,
        color=CARNEGIE_RED,
        linewidth=2.2,
        solid_capstyle="butt",
    )
    figure.add_artist(rule)


def save_figure(figure: plt.Figure, base: Path) -> None:
    figure.savefig(base.with_suffix(".pdf"))
    figure.savefig(base.with_suffix(".png"), dpi=300)
    plt.close(figure)


def aggregate_terminal_accuracy(states: pd.DataFrame) -> pd.DataFrame:
    terminal = states[
        states["decision_step"] == states["trajectory_length"]
    ].copy()
    rows = []
    for label, subset in (
        ("Incomplete\n$R_T<1$", terminal[terminal["r"] < 1]),
        ("Complete\n$R_T=1$", terminal[np.isclose(terminal["r"], 1)]),
    ):
        total = len(subset)
        correct = int(subset["correct"].sum())
        low, high = wilson_interval(correct, total)
        rows.append(
            {
                "label": label,
                "questions": total,
                "correct": correct,
                "accuracy": correct / total,
                "ci_low": low,
                "ci_high": high,
            }
        )
    return pd.DataFrame(rows)


def plot_main_story(
    temporal: pd.DataFrame,
    conditioned: pd.DataFrame,
    terminal_binary: pd.DataFrame,
    output: Path,
) -> None:
    figure = plt.figure(figsize=(7.55, 3.25))
    grid = figure.add_gridspec(
        1,
        3,
        width_ratios=[1.46, 1.0, 0.78],
        left=0.065,
        right=0.985,
        top=0.76,
        bottom=0.22,
        wspace=0.48,
    )
    axis_a = figure.add_subplot(grid[0, 0])
    axis_b = figure.add_subplot(grid[0, 1])
    axis_c = figure.add_subplot(grid[0, 2])
    add_top_rule(figure)
    figure.text(
        0.027,
        0.925,
        "Perceived sufficiency rises before evidence is complete",
        fontsize=13,
        fontweight="bold",
        ha="left",
        va="top",
        color=BLACK,
    )
    figure.text(
        0.027,
        0.855,
        "All 100 trajectories · 738 decision states · official MQuAKE gold chain",
        fontsize=7.8,
        ha="left",
        va="top",
        color=IRON_GRAY,
    )

    tau = temporal["normalized_progress"].to_numpy()
    r_mean = temporal["r_mean"].to_numpy()
    s_mean = temporal["native_s_mean"].to_numpy()
    j_mean = temporal["j_mean"].to_numpy()
    axis_a.fill_between(
        tau,
        r_mean,
        s_mean,
        where=s_mean >= r_mean,
        color=CARNEGIE_RED,
        alpha=0.085,
        linewidth=0,
        zorder=1,
    )
    for metric, mean, color, linestyle, linewidth in (
        ("r", r_mean, BLACK, "-", 1.8),
        ("native_s", s_mean, CARNEGIE_RED, "-", 2.0),
        ("j", j_mean, WEAVER_BLUE, (0, (3.2, 2.2)), 1.45),
    ):
        low = temporal[f"{metric}_ci_low"].to_numpy()
        high = temporal[f"{metric}_ci_high"].to_numpy()
        axis_a.fill_between(
            tau, low, high, color=color, alpha=0.10, linewidth=0, zorder=0
        )
        axis_a.plot(
            tau,
            mean,
            color=color,
            linestyle=linestyle,
            linewidth=linewidth,
            zorder=3,
        )

    gap = s_mean - r_mean
    gap_index = int(np.argmax(gap))
    gap_tau = float(tau[gap_index])
    axis_a.annotate(
        "",
        xy=(gap_tau, s_mean[gap_index]),
        xytext=(gap_tau, r_mean[gap_index]),
        arrowprops={
            "arrowstyle": "<->",
            "color": SKIBO_RED,
            "linewidth": 0.9,
            "shrinkA": 1,
            "shrinkB": 1,
        },
    )
    axis_a.text(
        gap_tau + 0.025,
        (s_mean[gap_index] + r_mean[gap_index]) / 2,
        f"max gap\n+{gap[gap_index]:.2f}",
        color=SKIBO_RED,
        fontsize=7.2,
        fontweight="bold",
        va="center",
    )
    endpoints = [
        (j_mean[-1], "Prompted $J$", WEAVER_BLUE, 0.015),
        (s_mean[-1], "Native $S$", CARNEGIE_RED, -0.008),
        (r_mean[-1], "Gold $R$", BLACK, -0.015),
    ]
    for value, label, color, offset in endpoints:
        axis_a.text(
            1.025,
            value + offset,
            f"{label}  {value:.2f}",
            color=color,
            fontsize=7.2,
            fontweight="bold",
            ha="left",
            va="center",
            clip_on=False,
        )
    axis_a.set(
        xlabel="Normalized acquisition progress, $t/T$",
        ylabel="Question-averaged value",
        xlim=(0, 1.31),
        ylim=(-0.02, 1.03),
    )
    axis_a.set_xticks(np.linspace(0, 1, 6))
    axis_a.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis_a)
    panel_message(axis_a, "A", "Sufficiency leads objective coverage")

    endpoints = conditioned[
        np.isclose(conditioned["r"], 0) | np.isclose(conditioned["r"], 1)
    ].set_index("r")
    metrics = [
        ("Explicit $J$", "j", WEAVER_BLUE),
        ("Native $S$", "native_s", CARNEGIE_RED),
        ("Native $\Delta>0$", "native_decision_rate", SKIBO_RED),
    ]
    y_positions = np.array([2, 1, 0])
    for y, (label, metric, color) in zip(y_positions, metrics):
        row0 = endpoints.loc[0.0]
        row1 = endpoints.loc[1.0]
        value0 = float(row0[f"{metric}_mean"])
        value1 = float(row1[f"{metric}_mean"])
        axis_b.plot(
            [value0, value1],
            [y, y],
            color=STEEL_GRAY,
            linewidth=2.0,
            zorder=1,
        )
        axis_b.errorbar(
            value0,
            y,
            xerr=np.array(
                [
                    [value0 - float(row0[f"{metric}_ci_low"])],
                    [float(row0[f"{metric}_ci_high"]) - value0],
                ]
            ),
            fmt="o",
            markersize=4.5,
            markerfacecolor=WHITE,
            markeredgecolor=IRON_GRAY,
            ecolor=IRON_GRAY,
            elinewidth=0.8,
            capsize=2,
            zorder=3,
        )
        axis_b.errorbar(
            value1,
            y,
            xerr=np.array(
                [
                    [value1 - float(row1[f"{metric}_ci_low"])],
                    [float(row1[f"{metric}_ci_high"]) - value1],
                ]
            ),
            fmt="o",
            markersize=5.2,
            markerfacecolor=color,
            markeredgecolor=color,
            ecolor=color,
            elinewidth=0.9,
            capsize=2,
            zorder=4,
        )
        axis_b.text(
            value0 - 0.025,
            y + 0.17,
            f"{value0:.2f}",
            color=IRON_GRAY,
            fontsize=7,
            ha="right",
            va="bottom",
        )
        axis_b.text(
            value1 + 0.018,
            y + 0.17,
            f"{value1:.2f}",
            color=color,
            fontsize=7,
            fontweight="bold",
            ha="left",
            va="bottom",
        )
    endpoint_legend = [
        mpl.lines.Line2D(
            [],
            [],
            marker="o",
            linestyle="none",
            markerfacecolor=WHITE,
            markeredgecolor=IRON_GRAY,
            markersize=4.5,
            label="$R=0$",
        ),
        mpl.lines.Line2D(
            [],
            [],
            marker="o",
            linestyle="none",
            markerfacecolor=CARNEGIE_RED,
            markeredgecolor=CARNEGIE_RED,
            markersize=4.5,
            label="$R=1$",
        ),
    ]
    axis_b.set(
        xlabel="Sufficiency readout",
        xlim=(0.30, 1.07),
        ylim=(-0.52, 2.50),
    )
    axis_b.set_yticks(y_positions, [item[0] for item in metrics])
    axis_b.set_xticks([0.4, 0.6, 0.8, 1.0])
    axis_b.legend(
        handles=endpoint_legend,
        loc="lower left",
        ncol=2,
        columnspacing=0.8,
        handletextpad=0.25,
    )
    tidy_axis(axis_b)
    panel_message(axis_b, "B", "Native signals change; $J$ is saturated")

    positions = np.arange(2)
    rates = terminal_binary["accuracy"].to_numpy()
    low = terminal_binary["ci_low"].to_numpy()
    high = terminal_binary["ci_high"].to_numpy()
    axis_c.bar(
        positions,
        rates,
        width=0.58,
        color=[IRON_GRAY, CARNEGIE_RED],
        zorder=2,
    )
    axis_c.errorbar(
        positions,
        rates,
        yerr=np.maximum(0, np.vstack([rates - low, high - rates])),
        fmt="none",
        color=BLACK,
        linewidth=0.8,
        capsize=2.5,
        zorder=3,
    )
    for position, row in terminal_binary.iterrows():
        axis_c.text(
            position,
            float(row["ci_high"]) + 0.025,
            f'{100 * float(row["accuracy"]):.0f}%\n'
            f'({int(row["correct"])}/{int(row["questions"])})',
            ha="center",
            va="bottom",
            fontsize=10.5,
            fontweight="bold",
            color=BLACK if position == 0 else CARNEGIE_RED,
        )
    ratio = rates[1] / rates[0]
    axis_c.annotate(
        f"{ratio:.1f}×",
        xy=(1, 0.98),
        xytext=(0, 0.98),
        ha="center",
        va="bottom",
        fontsize=8,
        fontweight="bold",
        color=SKIBO_RED,
        arrowprops={
            "arrowstyle": "->",
            "color": SKIBO_RED,
            "linewidth": 0.9,
            "shrinkA": 12,
            "shrinkB": 12,
        },
    )
    axis_c.set(
        ylabel="Official answer accuracy",
        ylim=(0, 1.08),
    )
    axis_c.set_xticks(positions, terminal_binary["label"])
    axis_c.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis_c)
    panel_message(axis_c, "C", "Full coverage sharply separates answer success")

    figure.text(
        0.027,
        0.045,
        "Curves average trajectories after normalization; coverage-conditioned estimates first average repeated states within question. "
        "Shading/error bars: 95% question-level bootstrap CI; accuracy: Wilson 95% CI.",
        fontsize=6.6,
        color=IRON_GRAY,
        ha="left",
    )
    save_figure(figure, output)


def replica_statistics(frame: pd.DataFrame) -> dict[str, float]:
    pair = frame.pivot_table(
        index=["question_id", "decision_step"],
        columns="replica",
        values=["j_sufficient_fraction", "native_logit_margin"],
        aggfunc="first",
    )
    j1 = pair[("j_sufficient_fraction", "qwen-r1")].to_numpy()
    j2 = pair[("j_sufficient_fraction", "qwen-r2")].to_numpy()
    m1 = pair[("native_logit_margin", "qwen-r1")].to_numpy()
    m2 = pair[("native_logit_margin", "qwen-r2")].to_numpy()
    return {
        "j_pearson": float(np.corrcoef(j1, j2)[0, 1]),
        "j_binary_agreement": float(np.mean((j1 > 0.5) == (j2 > 0.5))),
        "margin_pearson": float(np.corrcoef(m1, m2)[0, 1]),
        "margin_sign_agreement": float(np.mean((m1 > 0) == (m2 > 0))),
    }


def plot_proxy_story(
    states: pd.DataFrame,
    agreement: pd.DataFrame,
    composition: pd.DataFrame,
    reliability: dict[str, float],
    output: Path,
) -> None:
    figure = plt.figure(figsize=(7.55, 3.25))
    grid = figure.add_gridspec(
        1,
        3,
        width_ratios=[1.2, 0.93, 1.05],
        left=0.07,
        right=0.985,
        top=0.76,
        bottom=0.24,
        wspace=0.46,
    )
    axis_a = figure.add_subplot(grid[0, 0])
    axis_b = figure.add_subplot(grid[0, 1])
    axis_c = figure.add_subplot(grid[0, 2])
    add_top_rule(figure)
    figure.text(
        0.027,
        0.925,
        "Proxy discrepancies concentrate before evidence is complete",
        fontsize=13,
        fontweight="bold",
        ha="left",
        va="top",
        color=BLACK,
    )
    figure.text(
        0.027,
        0.855,
        "Native decisions use the logit-margin rule $\Delta>0$; no $S>0.5$ threshold is used",
        fontsize=7.8,
        ha="left",
        va="top",
        color=IRON_GRAY,
    )

    plot_groups = [
        (
            states[(states["r"] > 0) & (states["r"] < 1)],
            "Partial $R$",
            PALE_RED,
            "o",
            8,
            0.42,
        ),
        (states[np.isclose(states["r"], 0)], "$R=0$", IRON_GRAY, "o", 9, 0.38),
        (states[np.isclose(states["r"], 1)], "$R=1$", CARNEGIE_RED, "^", 13, 0.65),
    ]
    for subset, label, color, marker, size, alpha in plot_groups:
        axis_a.scatter(
            subset["j"],
            subset["native_margin"],
            s=size,
            marker=marker,
            color=color,
            alpha=alpha,
            linewidths=0,
            label=label,
            zorder=2,
        )
    axis_a.axhline(0, color=BLACK, linewidth=0.75, linestyle="--", zorder=1)
    axis_a.axvline(0.5, color=STEEL_GRAY, linewidth=0.75, zorder=1)
    axis_a.text(
        0.98,
        -8.8,
        "$J$ sufficient, native insufficient",
        ha="right",
        va="bottom",
        color=WEAVER_BLUE,
        fontsize=6.9,
    )
    axis_a.set(
        xlabel="Explicit sufficiency fraction, $J$",
        ylabel="Native logit margin, $\Delta$",
        xlim=(-0.02, 1.02),
        ylim=(-10.2, 10.2),
    )
    axis_a.legend(loc="upper left", ncol=1, handletextpad=0.3)
    tidy_axis(axis_a, grid=False)
    panel_message(axis_a, "A", "$J$ is positive across both native signs")

    positions = np.arange(len(agreement))
    values = agreement["agreement"].to_numpy()
    low = agreement["ci_low"].to_numpy()
    high = agreement["ci_high"].to_numpy()
    axis_b.fill_between(
        positions, low, high, color=CARNEGIE_RED, alpha=0.11, linewidth=0
    )
    axis_b.plot(
        positions,
        values,
        color=CARNEGIE_RED,
        marker="o",
        markersize=4.5,
        linewidth=1.7,
    )
    axis_b.axhline(0.5, color=IRON_GRAY, linewidth=0.75, linestyle="--")
    axis_b.text(
        positions[0],
        values[0] - 0.07,
        f"{values[0]:.2f}",
        ha="center",
        va="top",
        fontsize=8,
        fontweight="bold",
        color=SKIBO_RED,
    )
    axis_b.text(
        positions[-1],
        values[-1] + 0.04,
        f"{values[-1]:.2f}",
        ha="center",
        va="bottom",
        fontsize=8,
        fontweight="bold",
        color=SKIBO_RED,
    )
    axis_b.annotate(
        "agreement recovers",
        xy=(positions[-1] - 0.15, values[-1] - 0.02),
        xytext=(positions[2], 0.61),
        arrowprops={"arrowstyle": "->", "color": IRON_GRAY, "linewidth": 0.8},
        color=IRON_GRAY,
        fontsize=6.9,
        ha="center",
    )
    axis_b.set(
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Decision agreement",
        ylim=(0.32, 1.04),
    )
    axis_b.set_xticks(positions, R_LABELS)
    axis_b.set_yticks([0.4, 0.6, 0.8, 1.0])
    tidy_axis(axis_b)
    panel_message(axis_b, "B", "Agreement recovers with coverage")

    comp = composition.copy()
    comp["other"] = comp["both_insufficient"] + comp["native_only"]
    categories = [
        ("other", "Other", STEEL_GRAY),
        ("j_only", "$J$-only sufficient", WEAVER_BLUE),
        ("both_sufficient", "Both sufficient", CARNEGIE_RED),
    ]
    bottom = np.zeros(len(comp))
    for column, label, color in categories:
        values_c = comp[column].to_numpy()
        axis_c.bar(
            positions,
            values_c,
            width=0.70,
            bottom=bottom,
            color=color,
            label=label,
            zorder=2,
        )
        bottom += values_c
    axis_c.text(
        0,
        comp.loc[0, "other"] + comp.loc[0, "j_only"] / 2,
        f'{100 * comp.loc[0, "j_only"]:.0f}%\n$J$-only',
        color=WHITE,
        ha="center",
        va="center",
        fontsize=7.3,
        fontweight="bold",
    )
    axis_c.text(
        len(comp) - 1,
        comp.loc[len(comp) - 1, "other"]
        + comp.loc[len(comp) - 1, "j_only"]
        + comp.loc[len(comp) - 1, "both_sufficient"] / 2,
        f'{100 * comp.loc[len(comp) - 1, "both_sufficient"]:.0f}%\nboth',
        color=WHITE,
        ha="center",
        va="center",
        fontsize=7.3,
        fontweight="bold",
    )
    axis_c.set(
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Question-averaged fraction",
        ylim=(0, 1),
    )
    axis_c.set_xticks(positions, R_LABELS)
    axis_c.set_yticks(np.linspace(0, 1, 6))
    axis_c.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.20),
        ncol=3,
        handlelength=1.2,
        handletextpad=0.45,
        columnspacing=0.7,
    )
    tidy_axis(axis_c)
    panel_message(axis_c, "C", "Early mismatch is $J$-only sufficiency")

    figure.text(
        0.027,
        0.045,
        f'Replica reliability: $r_J$={reliability["j_pearson"]:.2f}, binary agreement={reliability["j_binary_agreement"]:.2f}; '
        f'$r_\\Delta$={reliability["margin_pearson"]:.2f}, sign agreement={reliability["margin_sign_agreement"]:.2f}. '
        "B–C first average repeated states within each question–coverage pair.",
        fontsize=6.6,
        color=IRON_GRAY,
        ha="left",
    )
    save_figure(figure, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bootstrap-draws", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()

    story_style()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    frame = pd.read_csv(args.input)
    states = collapse_replicas(frame)
    rng = np.random.default_rng(args.seed)
    temporal, _ = temporal_curves(states, rng, args.bootstrap_draws)
    conditioned = coverage_conditioned(states, rng, args.bootstrap_draws)
    # Retain the seven-level terminal table for a detailed supplementary view.
    terminal_detailed = terminal_accuracy(states)
    terminal_binary = aggregate_terminal_accuracy(states)
    agreement, composition = agreement_and_composition(
        frame, rng, args.bootstrap_draws
    )
    reliability = replica_statistics(frame)

    plot_main_story(
        temporal,
        conditioned,
        terminal_binary,
        args.output_dir / "sufficiency-story",
    )
    plot_proxy_story(
        states,
        agreement,
        composition,
        reliability,
        args.output_dir / "proxy-story",
    )

    terminal_binary.to_csv(args.output_dir / "terminal-accuracy-binary.csv", index=False)
    terminal_detailed.to_csv(
        args.output_dir / "terminal-accuracy-detailed.csv", index=False
    )
    estimates = {
        "schema_version": 1,
        "input": str(args.input.resolve()),
        "questions": int(states["question_id"].nunique()),
        "decision_states": len(states),
        "bootstrap_draws": args.bootstrap_draws,
        "seed": args.seed,
        "max_temporal_s_minus_r": {
            "normalized_progress": float(
                temporal.loc[
                    (temporal["native_s_mean"] - temporal["r_mean"]).idxmax(),
                    "normalized_progress",
                ]
            ),
            "gap": float(
                (temporal["native_s_mean"] - temporal["r_mean"]).max()
            ),
        },
        "r0": conditioned[np.isclose(conditioned["r"], 0)].iloc[0].to_dict(),
        "r1": conditioned[np.isclose(conditioned["r"], 1)].iloc[0].to_dict(),
        "terminal_accuracy": terminal_binary.to_dict(orient="records"),
        "replica_reliability": reliability,
        "native_binary_rule": "native_logit_margin > 0",
        "explicit_binary_rule": "j_sufficient_fraction > 0.5",
    }
    (args.output_dir / "story-estimates.json").write_text(
        json.dumps(estimates, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(estimates, indent=2))


if __name__ == "__main__":
    main()
