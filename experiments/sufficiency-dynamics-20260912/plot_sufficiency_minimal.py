#!/usr/bin/env python3
"""Create one-message-per-figure plots for Picorer sufficiency dynamics."""

from __future__ import annotations

import argparse
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
    STEEL_GRAY,
    WEAVER_BLUE,
    collapse_replicas,
    configure_style,
    coverage_conditioned,
    temporal_curves,
    tidy_axis,
)


def minimal_style() -> None:
    configure_style()
    mpl.rcParams.update(
        {
            "font.size": 8.5,
            "axes.titlesize": 9.5,
            "axes.titleweight": "normal",
            "axes.titlelocation": "left",
            "axes.labelsize": 8.5,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "legend.fontsize": 7.5,
            "axes.titlepad": 9,
        }
    )


def new_figure() -> tuple[plt.Figure, plt.Axes]:
    return plt.subplots(figsize=(3.75, 2.75))


def finish(figure: plt.Figure, output: Path) -> None:
    figure.subplots_adjust(left=0.16, right=0.97, top=0.88, bottom=0.19)
    figure.savefig(output.with_suffix(".pdf"))
    figure.savefig(output.with_suffix(".png"), dpi=300)
    plt.close(figure)


def plot_temporal(temporal: pd.DataFrame, output: Path) -> None:
    figure, axis = new_figure()
    x = temporal["normalized_progress"].to_numpy()
    for metric, label, color, linestyle in (
        ("r", "Gold coverage $R$", BLACK, "-"),
        ("native_s", "Native sufficiency $S$", CARNEGIE_RED, "-"),
    ):
        mean = temporal[f"{metric}_mean"].to_numpy()
        low = temporal[f"{metric}_ci_low"].to_numpy()
        high = temporal[f"{metric}_ci_high"].to_numpy()
        axis.fill_between(x, low, high, color=color, alpha=0.10, linewidth=0)
        axis.plot(x, mean, color=color, linewidth=1.7, linestyle=linestyle, label=label)
    axis.set(
        title="Sufficiency over evidence acquisition",
        xlabel="Normalized acquisition step, $t/T$",
        ylabel="Question-averaged value",
        xlim=(0, 1),
        ylim=(-0.02, 1.02),
    )
    axis.set_xticks(np.linspace(0, 1, 6))
    axis.set_yticks(np.linspace(0, 1, 6))
    axis.legend(loc="upper left")
    tidy_axis(axis)
    finish(figure, output)


def plot_coverage(conditioned: pd.DataFrame, output: Path) -> None:
    figure, axis = new_figure()
    positions = np.arange(len(conditioned))
    mean = conditioned["native_s_mean"].to_numpy()
    low = conditioned["native_s_ci_low"].to_numpy()
    high = conditioned["native_s_ci_high"].to_numpy()
    axis.fill_between(positions, low, high, color=CARNEGIE_RED, alpha=0.10)
    axis.plot(
        positions,
        mean,
        color=CARNEGIE_RED,
        linewidth=1.7,
        marker="o",
        markersize=4,
    )
    axis.set(
        title="Sufficiency as a function of evidence coverage",
        xlabel="Gold-evidence coverage, $R$",
        ylabel="Native sufficiency likelihood, $S$",
        ylim=(-0.02, 1.02),
    )
    axis.set_xticks(positions, R_LABELS)
    axis.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis)
    finish(figure, output)


def plot_proxy(states: pd.DataFrame, output: Path) -> None:
    figure, axis = new_figure()
    axis.scatter(
        states["native_s"],
        states["j"],
        s=9,
        facecolors=CARNEGIE_RED,
        edgecolors="none",
        alpha=0.24,
        rasterized=True,
    )
    axis.plot([0, 1], [0, 1], color=IRON_GRAY, linewidth=0.8, linestyle="--")
    axis.set(
        title="Native versus explicit sufficiency",
        xlabel="Native sufficiency likelihood, $S$",
        ylabel="Explicit sufficiency fraction, $J$",
        xlim=(-0.02, 1.02),
        ylim=(-0.02, 1.02),
    )
    axis.set_xticks(np.linspace(0, 1, 6))
    axis.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis, grid=False)
    finish(figure, output)


def plot_terminal_coverage(states: pd.DataFrame, output: Path) -> None:
    figure, axis = new_figure()
    terminal = states[
        states["decision_step"] == states["trajectory_length"]
    ].copy()
    groups = [
        terminal.loc[~terminal["correct"], "r"].to_numpy(),
        terminal.loc[terminal["correct"], "r"].to_numpy(),
    ]
    box = axis.boxplot(
        groups,
        positions=[0, 1],
        widths=0.42,
        patch_artist=True,
        showfliers=False,
        medianprops={"color": BLACK, "linewidth": 1.2},
        whiskerprops={"color": IRON_GRAY, "linewidth": 0.8},
        capprops={"color": IRON_GRAY, "linewidth": 0.8},
        boxprops={"edgecolor": IRON_GRAY, "linewidth": 0.8},
    )
    for patch, color in zip(box["boxes"], [IRON_GRAY, CARNEGIE_RED]):
        patch.set_facecolor(color)
        patch.set_alpha(0.13)
    rng = np.random.default_rng(20260913)
    for position, (values, color) in enumerate(
        zip(groups, [IRON_GRAY, CARNEGIE_RED])
    ):
        jitter = rng.uniform(-0.12, 0.12, size=len(values))
        axis.scatter(
            position + jitter,
            values,
            s=10,
            facecolors="none",
            edgecolors=color,
            linewidths=0.6,
            alpha=0.60,
            zorder=3,
        )
    axis.set(
        title="Terminal coverage by answer correctness",
        ylabel="Terminal gold-evidence coverage, $R_T$",
        xlim=(-0.55, 1.55),
        ylim=(-0.03, 1.03),
    )
    axis.set_xticks([0, 1], ["Incorrect", "Correct"])
    axis.set_yticks(np.linspace(0, 1, 6))
    tidy_axis(axis)
    finish(figure, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bootstrap-draws", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()

    minimal_style()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    frame = pd.read_csv(args.input)
    states = collapse_replicas(frame)
    rng = np.random.default_rng(args.seed)
    temporal, _ = temporal_curves(states, rng, args.bootstrap_draws)
    conditioned = coverage_conditioned(states, rng, args.bootstrap_draws)

    plot_temporal(temporal, args.output_dir / "sufficiency-over-acquisition")
    plot_coverage(conditioned, args.output_dir / "sufficiency-vs-coverage")
    plot_proxy(states, args.output_dir / "native-vs-explicit-sufficiency")
    plot_terminal_coverage(states, args.output_dir / "terminal-coverage-by-correctness")


if __name__ == "__main__":
    main()
