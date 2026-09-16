#!/usr/bin/env python3
"""Correctness-stratified Qwen3.6-27B acquisition dynamics.

The two figures use the predeclared 64-question unconflicted subset. The unit
of replication is the question: repeated runs and states remain clustered.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import numpy as np
import pandas as pd


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "analysis-rs-v4" / "states.csv"
SKILL = Path.home() / ".codex" / "skills" / "scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from figure_export import export_figure
from palette_audit import audit_palette

SEED = 20260915
BOOTSTRAP_DRAWS = 5000
GRID = np.arange(0, 21, dtype=float) / 20
RED = "#B21F32"
BLUE = "#245C7C"


def load_states() -> pd.DataFrame:
    states = pd.read_csv(SOURCE).sort_values(
        ["run_question", "decision_step"]
    ).reset_index(drop=True)
    assert len(states) == 2150
    assert states["question_id"].nunique() == 100
    assert states["run_question"].nunique() == 300
    assert states["round"].nunique() == 3
    assert not states.duplicated(["run_question", "decision_step"]).any()
    assert np.allclose(
        states["tau"], states["decision_step"] / states["trajectory_length"]
    )
    assert states[["native_s", "committed_r", "tau"]].notna().all().all()
    assert states.groupby("run_question")["terminal"].sum().eq(1).all()
    assert states.groupby("run_question")["correct"].nunique().eq(1).all()
    assert states.groupby("run_question")["conflicted"].nunique().eq(1).all()

    states = states.loc[~states["conflicted"].astype(bool)].copy()
    assert states["question_id"].nunique() == 64
    assert states["run_question"].nunique() == 192
    labels = states.groupby("run_question")["correct"].first()
    assert int(labels.sum()) == 123
    assert int((~labels.astype(bool)).sum()) == 69
    states["sufficiency_likelihood"] = 1.0 / (1.0 + np.exp(-states["native_s"]))
    assert states["trajectory_length"].gt(1).all()
    for _, trajectory in states.groupby("run_question"):
        assert np.array_equal(
            trajectory["decision_step"], np.arange(1, len(trajectory) + 1)
        )
        assert trajectory["trajectory_length"].eq(len(trajectory)).all()
        assert trajectory["committed_r"].diff().dropna().ge(-1e-12).all()
    # t=1 is the real initial request, before any tool execution. Align this
    # observed state to zero, and the last pre-finish decision to one.
    states["aligned_progress"] = (
        (states["decision_step"] - 1) / (states["trajectory_length"] - 1)
    ).round(12)
    return states


def calculate_group(
    states: pd.DataFrame, correct: bool
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict[str, object]]:
    selected_states = states.loc[states["correct"].astype(bool).eq(correct)].copy()
    rows: list[dict[str, object]] = []
    for run_question, trajectory in selected_states.groupby("run_question", sort=True):
        times = trajectory["aligned_progress"].to_numpy()
        assert times[0] == 0 and times[-1] == 1
        for progress in GRID:
            # Last observation carried forward over every observed breakpoint.
            # Each trajectory contributes its actual initial state at zero.
            index = np.searchsorted(times, progress + 1e-12, side="right") - 1
            assert index >= 0
            state = trajectory.iloc[index]
            rows.append({
                "outcome": "correct" if correct else "incorrect",
                "question_id": state["question_id"],
                "run_question": run_question,
                "run": state["round"],
                "progress": progress,
                "source_decision_step": int(state["decision_step"]),
                "source_aligned_progress": state["aligned_progress"],
                "sufficiency_likelihood": state["sufficiency_likelihood"],
                "evidence_coverage": state["committed_r"],
            })
    trajectories = pd.DataFrame(rows)
    assert trajectories.groupby("progress")["run_question"].nunique().eq(
        selected_states["run_question"].nunique()
    ).all()
    questions = (
        trajectories.groupby(["question_id", "progress"], as_index=False)[
            ["sufficiency_likelihood", "evidence_coverage"]
        ].mean()
    )

    # Resample questions, not trajectories. This keeps the three repeated
    # runs (where available in this outcome stratum) attached to each item.
    question_ids = np.sort(selected_states["question_id"].unique())
    rng = np.random.default_rng(SEED + int(not correct))
    sampled_question_rows = rng.integers(
        0, len(question_ids), size=(BOOTSTRAP_DRAWS, len(question_ids))
    )
    summary_rows: list[dict[str, object]] = []
    for metric in ["sufficiency_likelihood", "evidence_coverage"]:
        wide = (
            questions.pivot(index="question_id", columns="progress", values=metric)
            .reindex(index=question_ids, columns=GRID)
        )
        values = wide.to_numpy(dtype=float)
        assert np.isfinite(values).all()
        means = values.mean(axis=0)
        draws = np.full((BOOTSTRAP_DRAWS, len(GRID)), np.nan)
        for column in range(len(GRID)):
            sampled = values[sampled_question_rows, column]
            denominators = np.isfinite(sampled).sum(axis=1)
            numerators = np.nansum(sampled, axis=1)
            draws[:, column] = np.divide(
                numerators, denominators,
                out=np.full(BOOTSTRAP_DRAWS, np.nan), where=denominators > 0,
            )
        lows = np.full(len(GRID), np.nan)
        highs = np.full(len(GRID), np.nan)
        for column in range(len(GRID)):
            finite_draws = draws[np.isfinite(draws[:, column]), column]
            if finite_draws.size:
                lows[column], highs[column] = np.percentile(finite_draws, [2.5, 97.5])
        for index, progress in enumerate(GRID):
            at_progress = trajectories.loc[trajectories["progress"].eq(progress)]
            summary_rows.append({
                "outcome": "correct" if correct else "incorrect",
                "metric": metric,
                "progress": progress,
                "mean": means[index],
                "ci_low": lows[index],
                "ci_high": highs[index],
                "questions": int(wide.iloc[:, index].notna().sum()),
                "trajectories": int(at_progress["run_question"].nunique()),
            })
    summary = pd.DataFrame(summary_rows)
    assert summary["questions"].eq(len(question_ids)).all()
    coverage = summary.loc[summary["metric"].eq("evidence_coverage"), "mean"]
    assert coverage.diff().dropna().ge(-1e-12).all()
    group_metadata = {
        "outcome": "correct" if correct else "incorrect",
        "questions_with_at_least_one_trajectory": int(len(question_ids)),
        "trajectories": int(selected_states["run_question"].nunique()),
        "states": int(len(selected_states)),
        "constant_support_over_progress": True,
        "coverage_mean_decreases": int(coverage.diff().lt(-1e-12).sum()),
    }
    return trajectories, questions, summary, group_metadata


def draw(summary: pd.DataFrame, metadata: dict[str, object]) -> None:
    outcome = str(metadata["outcome"])
    trajectory_count = int(metadata["trajectories"])
    question_count = int(metadata["questions_with_at_least_one_trajectory"])
    group_title = "Correct final answer" if outcome == "correct" else "Incorrect final answer"
    rc = {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 8.5,
        "axes.labelsize": 9.2,
        "axes.titlesize": 10,
        "xtick.labelsize": 8.2,
        "ytick.labelsize": 8.2,
        "legend.fontsize": 8.3,
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
    specs = [
        ("sufficiency_likelihood", "Sufficiency", RED, "-", "o"),
        ("evidence_coverage", "Coverage", BLUE, "--", "s"),
    ]
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(4.15, 3.0), layout="constrained")
        for metric, label, color, linestyle, marker in specs:
            values = summary.loc[summary["metric"].eq(metric)].sort_values("progress")
            ax.fill_between(
                values["progress"], values["ci_low"], values["ci_high"],
                color=color, alpha=0.12, linewidth=0, zorder=1, step="post",
            )
            ax.plot(
                values["progress"], values["mean"],
                color=color, linestyle=linestyle, linewidth=1.65,
                solid_capstyle="round", zorder=2, drawstyle="steps-post",
            )
            marked = values.loc[np.isclose(
                values["progress"].to_numpy()[:, None],
                np.arange(6)[None, :] / 5, atol=1e-12, rtol=0,
            ).any(axis=1)]
            ax.plot(
                marked["progress"], marked["mean"], linestyle="none",
                marker=marker, markersize=3.8, markerfacecolor="white",
                markeredgecolor=color, markeredgewidth=0.9, zorder=3,
                clip_on=False,
            )
        handles = [
            Line2D([], [], color=color, linestyle=linestyle, linewidth=1.65,
                   marker=marker, markersize=3.8, markerfacecolor="white",
                   markeredgewidth=0.9, label=label)
            for _, label, color, linestyle, marker in specs
        ]
        ax.legend(
            handles=handles, loc="lower center", bbox_to_anchor=(0.5, 1.015),
            ncol=2, frameon=False, handlelength=2.4, handletextpad=0.55,
            columnspacing=1.8, borderaxespad=0,
        )
        ax.set_title(
            f"{group_title}  (n = {trajectory_count}; {question_count} questions)",
            loc="left", pad=28, fontweight="semibold",
        )
        ax.set_xlim(0, 1)
        ax.set_ylim(-0.025, 1.035)
        ax.set_xticks([0, 0.25, 0.50, 0.75, 1.0],
                      ["0", "0.25", "0.50", "0.75", "1"])
        ax.set_yticks([0, 0.25, 0.50, 0.75, 1.0],
                      ["0", "0.25", "0.50", "0.75", "1"])
        ax.set_xlabel("Normalized acquisition progress")
        ax.set_ylabel("Mean value")
        ax.grid(axis="y", color="#E5E5E5", linewidth=0.5)
        ax.set_axisbelow(True)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(length=3, width=0.7, pad=4)
        stem = f"{outcome}-normalized-dynamics"
        export_figure(
            fig, HERE / stem, formats=["pdf", "png"], dpi=600,
            bbox_inches=None, overwrite=True, write_manifest=True,
            provenance={
                "raw_data": str(SOURCE),
                "raw_data_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                "sample": (
                    f"Predeclared 64-question unconflicted subset; {trajectory_count} "
                    f"Qwen3.6-27B trajectories with {outcome} final answers; "
                    f"{question_count} unique questions"
                ),
                "transformations": [
                    "stratify trajectories by original final-answer correctness",
                    "normalize one-based decision index as (t-1)/(T-1)",
                    "use the union of all observed normalized states and a 0.05 reference grid",
                    "last observation carried forward; draw exact piecewise-constant means",
                    "use the actual initial observation at zero, without extrapolation",
                    "average outcome-matched runs within question, then questions; fixed weights throughout",
                    "map sufficient-vs-insufficient logit margin through the logistic function",
                ],
                "uncertainty": (
                    "95% pointwise question-cluster bootstrap; 5,000 draws; "
                    f"seed {SEED + int(outcome == 'incorrect')}"
                ),
                "missing_data": (
                    "none: every trajectory and question contributes at every displayed progress value"
                ),
                "alt_text": (
                    f"For trajectories with {outcome} final answers, mean sufficiency "
                    "likelihood and mean gold-evidence coverage are plotted against "
                    "normalized acquisition progress on identical zero-to-one axes."
                ),
                "destination": "Small standalone manuscript figure; journal requirements unspecified",
            },
        )
        plt.close(fig)


def main() -> None:
    global GRID
    HERE.mkdir(parents=True, exist_ok=True)
    states = load_states()
    # Include every observed change point. A coarse grid alone could miss a
    # brief downward excursion of the sufficiency readout.
    GRID = np.unique(np.round(np.concatenate([
        GRID, states["aligned_progress"].to_numpy(),
    ]), 12))
    states.to_csv(HERE / "aligned-observed-states.csv", index=False)
    all_trajectories: list[pd.DataFrame] = []
    all_questions: list[pd.DataFrame] = []
    all_summaries: list[pd.DataFrame] = []
    group_metadata: list[dict[str, object]] = []
    for correct in [True, False]:
        trajectories, questions, summary, metadata = calculate_group(states, correct)
        all_trajectories.append(trajectories)
        questions.insert(0, "outcome", metadata["outcome"])
        all_questions.append(questions)
        all_summaries.append(summary)
        group_metadata.append(metadata)
        draw(summary, metadata)

    pd.concat(all_trajectories, ignore_index=True).to_csv(
        HERE / "normalized-progress-trajectory-values.csv", index=False
    )
    pd.concat(all_questions, ignore_index=True).to_csv(
        HERE / "normalized-progress-question-values.csv", index=False
    )
    combined_summary = pd.concat(all_summaries, ignore_index=True)
    combined_summary.to_csv(HERE / "normalized-progress-means.csv", index=False)

    audit = audit_palette([RED, BLUE], background="#FFFFFF", role="graphical")
    (HERE / "palette-audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    metadata = {
        "source": str(SOURCE),
        "analysis_subset": "64 predeclared unconflicted questions",
        "runs": 3,
        "trajectories": 192,
        "correct_trajectories": 123,
        "incorrect_trajectories": 69,
        "grid": GRID.tolist(),
        "normalization": "(t-1)/(T-1), with t=1 the initial pre-tool decision",
        "aggregation": "outcome-matched runs within question, then questions; fixed weights and sample throughout",
        "alignment": "last observation carried forward at all observed breakpoints; no smoothing or monotonic fit",
        "bootstrap_unit": "question",
        "bootstrap_draws": BOOTSTRAP_DRAWS,
        "groups": group_metadata,
    }
    (HERE / "figure-metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    (HERE / "captions.tex").write_text(
        "\\textbf{Acquisition dynamics stratified by final-answer correctness.} "
        "Mean native sufficiency likelihood (red) and committed gold-evidence coverage "
        "(blue) over normalized acquisition progress for Qwen3.6-27B trajectories ending "
        "in a correct answer (123 trajectories) or an incorrect answer (69 trajectories). "
        "The analysis uses the predeclared 64-question subset without official-gold "
        "conflicts. For a trajectory with $T$ decision states indexed from $t=1$, "
        "progress is $(t-1)/(T-1)$, aligning the observed pre-tool initial state to zero "
        "and the last pre-finish state to one. The index includes search, read, and "
        "other agent decisions; it is not a search-call count. Each observation is "
        "carried forward until the next state, retaining every observed breakpoint. "
        "All trajectories contribute throughout: outcome-matched runs are averaged "
        "within question before averaging across questions with fixed weights. "
        "Bands are pointwise 95\\% question-cluster bootstrap intervals. No smoothing "
        "or monotonicity constraint is applied.\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, indent=2))
    print(
        combined_summary.loc[
            combined_summary["progress"].isin([0.5, 1.0]),
            ["outcome", "metric", "progress", "mean", "ci_low", "ci_high", "questions", "trajectories"],
        ].to_string(index=False)
    )


if __name__ == "__main__":
    main()
