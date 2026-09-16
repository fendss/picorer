#!/usr/bin/env python3
"""One publication figure: Qwen3.6-27B sufficiency and evidence dynamics.

Unit of replication: question. Three runs and every state remain attached to
their question during aggregation and bootstrap resampling.
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
from scipy.special import expit


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "analysis-rs-v4" / "states.csv"
SKILL = Path.home() / ".codex" / "skills" / "scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from figure_export import export_figure
from palette_audit import audit_palette

SEED = 20260915
BOOTSTRAP_DRAWS = 5000
GRID = np.arange(1, 21, dtype=float) / 20
RED = "#B21F32"
BLUE = "#245C7C"


def calculate() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
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

    # The displayed likelihood is the two-status likelihood implied by the
    # audited sufficient-vs-insufficient logit margin at each state.
    states["sufficiency_likelihood"] = expit(states["native_s"])
    rows: list[dict[str, object]] = []
    for _, trajectory in states.groupby("run_question", sort=True):
        times = trajectory["tau"].to_numpy()
        for progress in GRID:
            # Last observation carried forward, without extrapolating before
            # the first observed state of a trajectory.
            index = np.searchsorted(times, progress + 1e-12, side="right") - 1
            if index < 0:
                continue
            state = trajectory.iloc[index]
            rows.append({
                "question_id": state["question_id"],
                "run_question": state["run_question"],
                "run": state["round"],
                "progress": progress,
                "sufficiency_likelihood": state["sufficiency_likelihood"],
                "evidence_coverage": state["committed_r"],
            })
    trajectories = pd.DataFrame(rows)
    questions = (
        trajectories.groupby(["question_id", "progress"], as_index=False)[
            ["sufficiency_likelihood", "evidence_coverage"]
        ].mean()
    )

    rng = np.random.default_rng(SEED)
    summary: list[dict[str, object]] = []
    for metric in ["sufficiency_likelihood", "evidence_coverage"]:
        wide = questions.pivot(
            index="question_id", columns="progress", values=metric
        ).reindex(columns=GRID)
        values = wide.to_numpy(dtype=float)
        available = np.isfinite(values)
        weights = rng.multinomial(
            len(values), np.full(len(values), 1 / len(values)),
            size=BOOTSTRAP_DRAWS,
        )
        denominators = weights @ available.astype(float)
        numerators = weights @ np.nan_to_num(values)
        draws = np.divide(
            numerators, denominators,
            out=np.full_like(numerators, np.nan), where=denominators > 0,
        )
        means = np.nanmean(values, axis=0)
        lows, highs = np.nanpercentile(draws, [2.5, 97.5], axis=0)
        for index, progress in enumerate(GRID):
            selected = trajectories[trajectories["progress"].eq(progress)]
            summary.append({
                "metric": metric,
                "progress": progress,
                "mean": means[index],
                "ci_low": lows[index],
                "ci_high": highs[index],
                "questions": int(wide.iloc[:, index].notna().sum()),
                "trajectories": int(selected["run_question"].nunique()),
            })
    return trajectories, questions, pd.DataFrame(summary)


def draw(summary: pd.DataFrame) -> None:
    rc = {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 9.5,
        "axes.labelsize": 10.5,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "legend.fontsize": 9.5,
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
        ("sufficiency_likelihood", "Sufficiency likelihood", RED, "-", "o"),
        ("evidence_coverage", "Evidence coverage", BLUE, "--", "s"),
    ]
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(6.35, 3.65), layout="constrained")
        ax.axvspan(0, 1 / 3, color="#F3F3F3", zorder=-3)
        for metric, label, color, linestyle, marker in specs:
            values = summary[summary["metric"].eq(metric)].sort_values("progress")
            ax.fill_between(
                values["progress"], values["ci_low"], values["ci_high"],
                color=color, alpha=0.12, linewidth=0, zorder=1,
            )
            ax.plot(
                values["progress"], values["mean"],
                color=color, linestyle=linestyle, linewidth=1.75,
                solid_capstyle="round", zorder=2,
            )
            marked = values.iloc[1::2]
            ax.plot(
                marked["progress"], marked["mean"], linestyle="none",
                marker=marker, markersize=4.2, markerfacecolor="white",
                markeredgecolor=color, markeredgewidth=1.0, zorder=3,
            )
        handles = [
            Line2D([], [], color=color, linestyle=linestyle, linewidth=1.75,
                   marker=marker, markersize=4.2, markerfacecolor="white",
                   markeredgewidth=1.0, label=label)
            for _, label, color, linestyle, marker in specs
        ]
        ax.legend(
            handles=handles, loc="lower center", bbox_to_anchor=(0.5, 1.025),
            ncol=2, frameon=False, handlelength=2.7, handletextpad=0.65,
            columnspacing=2.4, borderaxespad=0,
        )
        ax.set_xlim(0, 1)
        ax.set_ylim(-0.025, 1.035)
        ax.set_xticks([0, 0.25, 0.50, 0.75, 1.0],
                      ["0", "0.25", "0.50", "0.75", "1"])
        ax.set_yticks([0, 0.25, 0.50, 0.75, 1.0],
                      ["0", "0.25", "0.50", "0.75", "1"])
        ax.set_xlabel("Normalized acquisition progress (t/T)")
        ax.set_ylabel("Mean value")
        ax.grid(axis="y", color="#E5E5E5", linewidth=0.55)
        ax.set_axisbelow(True)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(length=3, width=0.7, pad=4)
        export_figure(
            fig, HERE / "qwen-normalized-sufficiency-coverage",
            formats=["pdf", "png"], dpi=600, bbox_inches=None,
            overwrite=True, write_manifest=True,
            provenance={
                "raw_data": str(SOURCE),
                "raw_data_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                "sample": "100 FactConsolidation-MH questions; three Qwen3.6-27B runs; 300 trajectories; 2,150 states",
                "transformations": [
                    "normalize state index as t/T",
                    "evaluate a 0.05 grid using last observation carried forward",
                    "do not extrapolate before a trajectory's first observed state",
                    "average available runs within question, then average questions",
                    "map each audited sufficient-vs-insufficient logit margin to its two-status likelihood before aggregation",
                ],
                "uncertainty": "95% pointwise question-cluster bootstrap; 5,000 draws; seed 20260915",
                "missing_data": "gray region ends at first grid point with all 300 trajectories observed; early estimates retain all available observations",
                "alt_text": "Sufficiency likelihood and gold-evidence coverage both rise over normalized acquisition progress; sufficiency rises earlier, while evidence coverage increases gradually and jumps at the terminal state.",
                "destination": "General manuscript figure, approximately 161 mm wide; journal requirements unspecified",
            },
        )
        plt.close(fig)


def main() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    trajectories, questions, summary = calculate()
    trajectories.to_csv(HERE / "normalized-progress-trajectory-values.csv", index=False)
    questions.to_csv(HERE / "normalized-progress-question-values.csv", index=False)
    summary.to_csv(HERE / "normalized-progress-means.csv", index=False)
    draw(summary)
    audit = audit_palette([RED, BLUE], background="#FFFFFF", role="graphical")
    (HERE / "palette-audit.json").write_text(
        json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    metadata = {
        "questions": 100,
        "runs": 3,
        "trajectories": 300,
        "states": 2150,
        "grid": GRID.tolist(),
        "aggregation": "available runs within question, then questions",
        "bootstrap_unit": "question",
        "bootstrap_draws": BOOTSTRAP_DRAWS,
        "bootstrap_seed": SEED,
        "first_grid_with_all_trajectories": float(
            summary.loc[summary["trajectories"].eq(300), "progress"].min()
        ),
    }
    (HERE / "figure-metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    print(json.dumps(metadata, indent=2))
    print(summary[summary["progress"].isin([0.5, 1.0])].to_string(index=False))


if __name__ == "__main__":
    main()
