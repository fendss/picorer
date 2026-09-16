#!/usr/bin/env python3
"""Offline paired visualization of the controlled gold-evidence intervention."""
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
ROOT = HERE.parents[1]
SOURCE = ROOT / "summary" / "units.csv"
SKILL = Path.home() / ".codex" / "skills" / "scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from figure_export import export_figure
from palette_audit import audit_palette

SEED = 20260914
BOOTSTRAP_DRAWS = 2000
ACCENT = "#B21F32"
GRAY = "#9A9A9A"


def construct_pairs() -> tuple[pd.DataFrame, pd.DataFrame]:
    data = pd.read_csv(SOURCE)
    coverage = data[
        data["experiment"].eq("coverage")
        & data["complete"]
        & ~data["conflicted"]
    ].copy()
    assert coverage["question_id"].nunique() == 64
    assert coverage["native_n"].eq(2).all()

    records: list[dict[str, object]] = []
    for (question_id, order), group in coverage.groupby(
        ["question_id", "order"], sort=True
    ):
        by_mask = {int(row["mask"]): row for row in group.to_dict("records")}
        hops = int(group.iloc[0]["gold_hops"])
        for mask, control in by_mask.items():
            for bit in range(hops):
                if mask & (1 << bit):
                    continue
                intervention = by_mask.get(mask | (1 << bit))
                assert intervention is not None
                assert np.isclose(
                    intervention["r"] - control["r"], 1 / hops
                )
                records.append({
                    "question_id": question_id,
                    "gold_hops": hops,
                    "order": int(order),
                    "starting_mask": mask,
                    "added_hop": bit + 1,
                    "control_coverage": control["r"],
                    "intervention_coverage": intervention["r"],
                    "control_likelihood": control["likelihood"],
                    "intervention_likelihood": intervention["likelihood"],
                    "paired_change": (
                        intervention["likelihood"] - control["likelihood"]
                    ),
                    "token_change": (
                        intervention["input_tokens"] - control["input_tokens"]
                    ),
                })
    pairs = pd.DataFrame(records)
    question_means = (
        pairs.groupby(["question_id", "gold_hops"], as_index=False)[
            ["control_likelihood", "intervention_likelihood",
             "paired_change", "token_change"]
        ].mean()
    )
    assert len(pairs) == 1072
    assert len(question_means) == 64
    assert np.allclose(
        question_means["intervention_likelihood"]
        - question_means["control_likelihood"],
        question_means["paired_change"],
    )
    return pairs, question_means


def summarize(question_means: pd.DataFrame) -> dict[str, object]:
    delta = question_means["paired_change"].to_numpy()
    rng = np.random.default_rng(SEED)
    boot = rng.choice(
        delta, size=(BOOTSTRAP_DRAWS, len(delta)), replace=True
    ).mean(axis=1)
    low, high = np.percentile(boot, [2.5, 97.5])
    return {
        "questions": len(question_means),
        "eligible_matched_pairs": 1072,
        "control_mean": float(question_means["control_likelihood"].mean()),
        "intervention_mean": float(
            question_means["intervention_likelihood"].mean()
        ),
        "mean_paired_change": float(delta.mean()),
        "ci_low": float(low),
        "ci_high": float(high),
        "questions_with_positive_mean_change": int((delta > 0).sum()),
        "bootstrap_draws": BOOTSTRAP_DRAWS,
        "bootstrap_seed": SEED,
        "unit_of_inference": "question",
    }


def draw(question_means: pd.DataFrame, result: dict[str, object]) -> None:
    style = {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 10,
        "axes.labelsize": 11,
        "xtick.labelsize": 10,
        "ytick.labelsize": 9.5,
        "legend.fontsize": 9.2,
        "axes.edgecolor": "#505050",
        "axes.linewidth": 0.7,
        "text.color": "#252525",
        "axes.labelcolor": "#252525",
        "xtick.color": "#303030",
        "ytick.color": "#505050",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "savefig.facecolor": "white",
    }
    with plt.rc_context(style):
        fig, ax = plt.subplots(figsize=(5.1, 3.85), layout="constrained")
        for row in question_means.itertuples(index=False):
            ax.plot(
                [0, 1], [row.control_likelihood, row.intervention_likelihood],
                color=GRAY, alpha=0.30, linewidth=0.65, zorder=1,
            )
            ax.scatter(
                [0, 1], [row.control_likelihood, row.intervention_likelihood],
                color=GRAY, alpha=0.42, s=7, linewidths=0, zorder=2,
            )

        before = result["control_mean"]
        after = result["intervention_mean"]
        ax.plot(
            [0, 1], [before, after], color=ACCENT, linewidth=2.6,
            solid_capstyle="round", zorder=4,
        )
        ax.scatter(
            [0, 1], [before, after], s=58, facecolor="white",
            edgecolor=ACCENT, linewidth=1.8, zorder=5,
        )
        ax.text(
            0, before - 0.055, f"{before:.3f}", ha="center", va="top",
            color=ACCENT, fontsize=9.5,
        )
        ax.text(
            1, after + 0.045, f"{after:.3f}", ha="center", va="bottom",
            color=ACCENT, fontsize=9.5,
        )
        ax.text(
            0.5, 0.965,
            f"Mean paired increase: +{result['mean_paired_change']:.3f}",
            ha="center", va="top", color=ACCENT, fontsize=10.2,
        )
        ax.text(
            0.5, 0.915,
            f"95% CI [{result['ci_low']:.3f}, {result['ci_high']:.3f}]",
            ha="center", va="top", color="#505050", fontsize=9.1,
        )
        legend = [
            Line2D([], [], color=GRAY, alpha=0.55, linewidth=0.8,
                   marker="o", markersize=3, label="Question mean (n = 64)"),
            Line2D([], [], color=ACCENT, linewidth=2.4,
                   marker="o", markerfacecolor="white", markersize=6,
                   label="Overall mean"),
        ]
        ax.legend(
            handles=legend, loc="lower center", bbox_to_anchor=(0.5, 1.015),
            frameon=False, ncol=2, handlelength=2.0, columnspacing=1.8,
            borderaxespad=0,
        )
        ax.set_xlim(-0.24, 1.24)
        ax.set_ylim(0, 1.02)
        ax.set_xticks(
            [0, 1],
            ["Matched control\nIrrelevant fact in slot",
             "Evidence intervention\nGold fact in the same slot"],
        )
        ax.set_yticks([0, 0.25, 0.50, 0.75, 1.0],
                      ["0", "0.25", "0.50", "0.75", "1"])
        ax.set_ylabel("Sufficiency likelihood")
        ax.grid(axis="y", color="#E7E7E7", linewidth=0.55)
        ax.set_axisbelow(True)
        ax.spines[["top", "right", "bottom"]].set_visible(False)
        ax.tick_params(axis="x", length=0, pad=8)
        ax.tick_params(axis="y", length=3, width=0.7, pad=4)
        export_figure(
            fig, HERE / "paired-gold-evidence-effect",
            formats=["pdf", "png"], dpi=600, bbox_inches=None,
            overwrite=True, write_manifest=True,
            provenance={
                "raw_data": str(SOURCE),
                "raw_data_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                "sample": "64 predeclared FactConsolidation-MH questions without known gold conflicts",
                "transformations": [
                    "coverage experiment only; all complete units retained",
                    "construct every within-question, within-order pair differing by exactly one gold fact",
                    "the absent gold fact is replaced by a word-length-matched unrelated fact",
                    "average all eligible pairs within question before averaging questions",
                ],
                "uncertainty": "95% percentile bootstrap over 64 question means; 2,000 draws; seed 20260914",
                "alt_text": "All 64 gray question-average lines rise from the matched control to the one-gold-fact intervention. The overall mean sufficiency likelihood rises from 0.360 to 0.809, a paired increase of 0.449 with 95% CI 0.428 to 0.466.",
                "destination": "General manuscript figure, approximately 130 mm wide; journal requirements unspecified",
            },
        )
        plt.close(fig)


def main() -> None:
    pairs, question_means = construct_pairs()
    result = summarize(question_means)
    pairs.to_csv(HERE / "matched-pairs.csv", index=False)
    question_means.to_csv(HERE / "question-paired-means.csv", index=False)
    pd.DataFrame([result]).to_csv(HERE / "summary.csv", index=False)
    draw(question_means, result)
    (HERE / "palette-audit.json").write_text(
        json.dumps(
            audit_palette([ACCENT, GRAY], background="#FFFFFF", role="graphical"),
            indent=2, ensure_ascii=False,
        ), encoding="utf-8",
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
