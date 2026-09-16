#!/usr/bin/env python3
"""Ten-pass offline analysis for Picorer sufficiency dynamics.

The script uses the three completed 100-question runs and the exact-match
audit of gold statements visible in search previews.  It produces one clean
figure and one machine-readable result for each analysis pass.  Question IDs,
not individual states, are the resampling unit throughout.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path
from typing import Iterable

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns


CMU_RED = "#C41230"
CMU_DARK_RED = "#8B1538"
TEAL = "#147D92"
DARK_TEAL = "#0A5364"
NAVY = "#182C4B"
GOLD = "#B98900"
CHARCOAL = "#252A34"
MID_GRAY = "#747B85"
LIGHT_GRAY = "#D9DCE1"
PALE_GRAY = "#F1F2F4"
PALE_TEAL = "#B9DCE1"
WHITE = "#FFFFFF"

RUN_INPUTS = {
    "Run 1": "coverage/run1/state-replica.csv",
    "Run 2": "coverage/run2/state-replica.csv",
    "Run 3": "coverage/complete-run/state-replica.csv",
}


def configure_style() -> None:
    sns.set_theme(context="paper", style="ticks")
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": [
                "PingFang SC",
                "Heiti SC",
                "Arial Unicode MS",
                "Arial",
                "DejaVu Sans",
            ],
            "axes.unicode_minus": False,
            "font.size": 8.2,
            "axes.labelsize": 8.8,
            "axes.edgecolor": CHARCOAL,
            "axes.linewidth": 0.75,
            "xtick.labelsize": 7.8,
            "ytick.labelsize": 7.8,
            "figure.facecolor": WHITE,
            "axes.facecolor": WHITE,
            "savefig.facecolor": WHITE,
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.05,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def tidy(axis: plt.Axes, *, xgrid: bool = False, ygrid: bool = True) -> None:
    sns.despine(ax=axis)
    axis.set_axisbelow(True)
    axis.grid(axis="x", color=LIGHT_GRAY, linewidth=0.55, alpha=0.75 if xgrid else 0)
    axis.grid(axis="y", color=LIGHT_GRAY, linewidth=0.55, alpha=0.75 if ygrid else 0)


def save_figure(figure: plt.Figure, output_dir: Path, stem: str) -> None:
    figure.savefig(output_dir / f"{stem}.pdf")
    figure.savefig(output_dir / f"{stem}.png", dpi=450)
    plt.close(figure)


def json_number(value: object) -> object:
    if isinstance(value, (np.floating, float)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def percentile(values: np.ndarray) -> tuple[float, float]:
    clean = np.asarray(values, dtype=float)
    clean = clean[np.isfinite(clean)]
    if not len(clean):
        return math.nan, math.nan
    low, high = np.percentile(clean, [2.5, 97.5])
    return float(low), float(high)


def load_data(experiment_dir: Path, visible_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    raw_frames = []
    for run, relative in RUN_INPUTS.items():
        path = experiment_dir / relative
        frame = pd.read_csv(path)
        frame["round"] = run
        raw_frames.append(frame)
    raw = pd.concat(raw_frames, ignore_index=True)
    state_sizes = raw.groupby(["round", "question_id", "decision_step"]).size()
    if len(raw) != 4300 or len(state_sizes) != 2150 or not (state_sizes == 2).all():
        raise ValueError("expected 4,300 rows, 2,150 states, and two replicas per state")
    if set(raw["replica"].unique()) != {"qwen-r1", "qwen-r2"}:
        raise ValueError(f"unexpected replicas: {sorted(raw['replica'].unique())}")
    if not (raw["j_sample_count"] == 101).all():
        raise ValueError("every state-replica row must contain 101 J samples")

    states = pd.read_csv(visible_path)
    if len(states) != 2150 or states["run_question"].nunique() != 300:
        raise ValueError("visible-context table must contain 2,150 states and 300 trajectories")
    if states["question_id"].nunique() != 100:
        raise ValueError("expected 100 benchmark questions")

    collapsed = (
        raw.groupby(["round", "question_id", "decision_step"], as_index=False)
        .agg(native_s_check=("native_logit_margin", "mean"), explicit_j_check=("j_sufficient_fraction", "mean"))
    )
    check = states.merge(collapsed, on=["round", "question_id", "decision_step"], validate="one_to_one")
    if not np.allclose(check["native_s"], check["native_s_check"], atol=1e-8):
        raise ValueError("native S in visible-context table does not match raw replicas")
    if not np.allclose(check["explicit_j"], check["explicit_j_check"], atol=1e-12):
        raise ValueError("explicit J in visible-context table does not match raw replicas")

    states = states.sort_values(["run_question", "decision_step"]).reset_index(drop=True)
    grouped = states.groupby("run_question", sort=False)
    for column in [
        "native_s",
        "committed_r",
        "current_preview_coverage",
        "ever_seen_or_committed_coverage",
    ]:
        states[f"prev_{column}"] = grouped[column].shift()
        states[f"delta_{column}"] = grouped[column].diff()
    states["native_positive"] = states["native_s"] > 0
    states["prev_native_positive"] = states["prev_native_s"] > 0
    states["reversal"] = states["prev_native_positive"] & ~states["native_positive"]
    states["terminal"] = states["decision_step"] == states["trajectory_length"]
    states["full_committed"] = states["committed_r"] >= 1 - 1e-12
    states["full_visible"] = states["ever_seen_or_committed_coverage"] >= 1 - 1e-12
    states["current_preview_any"] = states["current_preview_coverage"] > 1e-12
    return raw, states


def agreement_statistics(pivot: pd.DataFrame) -> dict[str, float]:
    left = pivot.iloc[:, 0].to_numpy(dtype=float)
    right = pivot.iloc[:, 1].to_numpy(dtype=float)
    difference = left - right
    correlation = float(np.corrcoef(left, right)[0, 1])
    n, k = len(left), 2
    values = np.column_stack([left, right])
    grand = values.mean()
    row_mean = values.mean(axis=1)
    column_mean = values.mean(axis=0)
    ss_rows = k * np.square(row_mean - grand).sum()
    ss_columns = n * np.square(column_mean - grand).sum()
    ss_error = np.square(values - row_mean[:, None] - column_mean[None, :] + grand).sum()
    ms_rows = ss_rows / (n - 1)
    ms_columns = ss_columns / (k - 1)
    ms_error = ss_error / ((n - 1) * (k - 1))
    icc = (ms_rows - ms_error) / (
        ms_rows + (k - 1) * ms_error + k * (ms_columns - ms_error) / n
    )
    return {
        "pearson_r": correlation,
        "icc_2_1": float(icc),
        "mean_absolute_difference": float(np.abs(difference).mean()),
        "mean_difference": float(difference.mean()),
        "loa_low": float(difference.mean() - 1.96 * difference.std(ddof=1)),
        "loa_high": float(difference.mean() + 1.96 * difference.std(ddof=1)),
        "sign_disagreement_rate": float((np.sign(left) != np.sign(right)).mean()),
    }


def cluster_weights(frame: pd.DataFrame, rng: np.random.Generator, draws: int) -> tuple[list[str], np.ndarray]:
    questions = sorted(frame["question_id"].unique())
    weights = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    return questions, weights


def clustered_ols(
    frame: pd.DataFrame,
    x: np.ndarray,
    y: np.ndarray,
    rng: np.random.Generator,
    draws: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    estimate = np.linalg.lstsq(x, y, rcond=None)[0]
    questions = sorted(frame["question_id"].unique())
    q_index = {question: index for index, question in enumerate(questions)}
    p = x.shape[1]
    xtx = np.zeros((len(questions), p, p), dtype=float)
    xty = np.zeros((len(questions), p), dtype=float)
    for question, subset in frame.groupby("question_id"):
        idx = subset.index.to_numpy()
        local_x = x[idx]
        local_y = y[idx]
        position = q_index[question]
        # ``einsum`` avoids a spurious Accelerate/NumPy 2 overflow warning
        # observed for very small finite matrices with the ``@`` dispatcher.
        xtx[position] = np.einsum("ni,nj->ij", local_x, local_x)
        xty[position] = np.einsum("ni,n->i", local_x, local_y)
    weights = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    draw_xtx = np.einsum("bq,qij->bij", weights, xtx)
    draw_xty = np.einsum("bq,qi->bi", weights, xty)
    ridge = np.eye(p) * 1e-9
    ridge[0, 0] = 0
    draw_beta = np.linalg.solve(
        draw_xtx + ridge[None, :, :], draw_xty[:, :, None]
    )[:, :, 0]
    low = np.nanpercentile(draw_beta, 2.5, axis=0)
    high = np.nanpercentile(draw_beta, 97.5, axis=0)
    return estimate, low, high


def pass_01_reliability(raw: pd.DataFrame, output_dir: Path) -> dict:
    s_pivot = raw.pivot(
        index=["round", "question_id", "decision_step"],
        columns="replica",
        values="native_logit_margin",
    )
    j_pivot = raw.pivot(
        index=["round", "question_id", "decision_step"],
        columns="replica",
        values="j_sufficient_fraction",
    )
    s_stats = agreement_statistics(s_pivot)
    j_stats = agreement_statistics(j_pivot)
    rows = []
    for measure, stats in [("Native S", s_stats), ("Explicit J", j_stats)]:
        rows.append({"measure": measure, **stats})
    pd.DataFrame(rows).to_csv(output_dir / "01-measurement-reliability.csv", index=False)

    figure, axis = plt.subplots(figsize=(4.25, 3.85))
    axis.hexbin(
        s_pivot.iloc[:, 0],
        s_pivot.iloc[:, 1],
        gridsize=42,
        mincnt=1,
        cmap=mpl.colors.LinearSegmentedColormap.from_list("cmu_density", [PALE_TEAL, TEAL, DARK_TEAL]),
        linewidths=0,
    )
    limits = [-11.8, 11.6]
    axis.plot(limits, limits, color=CMU_RED, linewidth=1.1, zorder=3)
    axis.axhline(0, color=LIGHT_GRAY, linewidth=0.65)
    axis.axvline(0, color=LIGHT_GRAY, linewidth=0.65)
    axis.set_xlim(limits)
    axis.set_ylim(limits)
    axis.set_aspect("equal")
    axis.set_xlabel("副本 1 的 S")
    axis.set_ylabel("副本 2 的 S")
    axis.text(
        0.04,
        0.95,
        f"r = {s_stats['pearson_r']:.4f}\n符号不一致 = {s_stats['sign_disagreement_rate'] * 100:.1f}%",
        transform=axis.transAxes,
        ha="left",
        va="top",
        color=CHARCOAL,
    )
    tidy(axis, xgrid=False, ygrid=False)
    save_figure(figure, output_dir, "01-native-replica-agreement")
    return {"native_s": s_stats, "explicit_j": j_stats}


def pass_02_j_negative_control(states: pd.DataFrame, output_dir: Path) -> dict:
    initial = states[states["decision_step"] == 1].copy()
    summary = {
        "states": int(len(initial)),
        "native_positive_rate": float((initial["native_s"] > 0).mean()),
        "j_majority_sufficient_rate": float((initial["explicit_j"] > 0.5).mean()),
        "j_mean": float(initial["explicit_j"].mean()),
        "j_median": float(initial["explicit_j"].median()),
        "j_q05": float(initial["explicit_j"].quantile(0.05)),
        "j_q95": float(initial["explicit_j"].quantile(0.95)),
    }
    pd.DataFrame([summary]).to_csv(output_dir / "02-j-negative-control.csv", index=False)

    figure, axis = plt.subplots(figsize=(4.7, 3.1))
    bins = np.linspace(0, 1, 21)
    axis.hist(initial["explicit_j"], bins=bins, color=CMU_RED, alpha=0.88, edgecolor=WHITE, linewidth=0.7)
    axis.axvline(0.5, color=CHARCOAL, linestyle="--", linewidth=1.0)
    axis.axvline(summary["j_median"], color=NAVY, linewidth=1.2)
    axis.text(0.51, axis.get_ylim()[1] * 0.93, "多数票阈值", ha="left", va="top", fontsize=7.5)
    axis.text(
        0.04,
        0.91,
        f"297 / 300 个状态判为充分\n中位数 = {summary['j_median']:.3f}",
        transform=axis.transAxes,
        ha="left",
        va="top",
    )
    axis.set_xlim(0, 1)
    axis.set_xlabel("尚未检索时，J 回答“充分”的比例")
    axis.set_ylabel("状态数")
    tidy(axis)
    save_figure(figure, output_dir, "02-explicit-j-negative-control")
    return summary


def first_event(group: pd.DataFrame, column: str, threshold: float = 1e-12) -> float:
    found = group[group[column] > threshold]
    return float(found["tau"].iloc[0]) if len(found) else math.nan


def first_event_step(group: pd.DataFrame, column: str, threshold: float = 1e-12) -> float:
    found = group[group[column] > threshold]
    return float(found["decision_step"].iloc[0]) if len(found) else math.nan


def first_complete(group: pd.DataFrame, column: str) -> float:
    found = group[group[column] >= 1 - 1e-12]
    return float(found["tau"].iloc[0]) if len(found) else math.nan


def first_complete_step(group: pd.DataFrame, column: str) -> float:
    found = group[group[column] >= 1 - 1e-12]
    return float(found["decision_step"].iloc[0]) if len(found) else math.nan


def make_event_table(states: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for run_question, group in states.groupby("run_question", sort=False):
        group = group.sort_values("decision_step")
        rows.append(
            {
                "run_question": run_question,
                "round": group["round"].iloc[0],
                "question_id": group["question_id"].iloc[0],
                "first_visible_any_tau": first_event(group, "ever_seen_or_committed_coverage"),
                "first_visible_any_step": first_event_step(group, "ever_seen_or_committed_coverage"),
                "first_s_positive_tau": first_event(group, "native_s", threshold=0),
                "first_s_positive_step": first_event_step(group, "native_s", threshold=0),
                "first_committed_any_tau": first_event(group, "committed_r"),
                "first_committed_any_step": first_event_step(group, "committed_r"),
                "first_visible_full_tau": first_complete(group, "ever_seen_or_committed_coverage"),
                "first_visible_full_step": first_complete_step(group, "ever_seen_or_committed_coverage"),
                "first_committed_full_tau": first_complete(group, "committed_r"),
                "first_committed_full_step": first_complete_step(group, "committed_r"),
            }
        )
    return pd.DataFrame(rows)


def pass_03_event_ordering(states: pd.DataFrame, output_dir: Path) -> tuple[dict, pd.DataFrame]:
    events = make_event_table(states)
    events.to_csv(output_dir / "03-event-times.csv", index=False)
    definitions = [
        ("first_visible_any_tau", "看见首条证据", DARK_TEAL, "-"),
        ("first_s_positive_tau", "S 首次转正", CMU_RED, "-"),
        ("first_committed_any_tau", "提交首条证据", NAVY, "-"),
        ("first_visible_full_tau", "看见完整证据链", GOLD, "--"),
        ("first_committed_full_tau", "提交完整证据链", CHARCOAL, "--"),
    ]
    grid = np.linspace(0, 1, 201)
    figure, axis = plt.subplots(figsize=(5.2, 3.45))
    summaries = {}
    for column, label, color, linestyle in definitions:
        values = events[column].to_numpy(dtype=float)
        curve = np.array([np.mean(values <= point) for point in grid])
        axis.plot(grid, curve, color=color, linestyle=linestyle, linewidth=1.8, label=label)
        reached = values[np.isfinite(values)]
        summaries[column] = {
            "reached": int(len(reached)),
            "reached_rate": float(len(reached) / len(values)),
            "median_tau_among_reached": float(np.median(reached)) if len(reached) else None,
        }
    both_visible_s = events.dropna(subset=["first_visible_any_step", "first_s_positive_step"])
    visible_to_s = both_visible_s["first_s_positive_step"] - both_visible_s["first_visible_any_step"]
    both_s_commit = events.dropna(subset=["first_s_positive_step", "first_committed_any_step"])
    s_to_commit = both_s_commit["first_committed_any_step"] - both_s_commit["first_s_positive_step"]
    both_s_full = events.dropna(subset=["first_s_positive_step", "first_committed_full_step"])
    s_to_full = both_s_full["first_committed_full_step"] - both_s_full["first_s_positive_step"]
    summaries["pairwise_order"] = {
        "visible_any_vs_s_positive": {
            "both_reached": int(len(visible_to_s)),
            "s_before_visible": int((visible_to_s < 0).sum()),
            "same_state": int((visible_to_s == 0).sum()),
            "s_after_visible": int((visible_to_s > 0).sum()),
            "median_step_lag_s_minus_visible": float(visible_to_s.median()),
        },
        "s_positive_vs_committed_any": {
            "both_reached": int(len(s_to_commit)),
            "s_before_commit": int((s_to_commit > 0).sum()),
            "same_state": int((s_to_commit == 0).sum()),
            "s_after_commit": int((s_to_commit < 0).sum()),
            "median_step_lag_commit_minus_s": float(s_to_commit.median()),
        },
        "s_positive_vs_committed_full": {
            "both_reached": int(len(s_to_full)),
            "s_before_full": int((s_to_full > 0).sum()),
            "same_state": int((s_to_full == 0).sum()),
            "s_after_full": int((s_to_full < 0).sum()),
            "median_step_lag_full_minus_s": float(s_to_full.median()),
        },
    }
    axis.set_xlim(0, 1)
    axis.set_ylim(0, 1.01)
    axis.set_xlabel("归一化检索进度")
    axis.set_ylabel("已经发生该事件的轨迹比例")
    axis.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.legend(loc="upper center", bbox_to_anchor=(0.5, -0.24), ncol=2, frameon=False)
    tidy(axis)
    save_figure(figure, output_dir, "03-event-ordering")
    return summaries, events


def trajectory_first_positive(states: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for run_question, group in states.groupby("run_question", sort=False):
        group = group.sort_values("decision_step")
        positive = group[group["native_s"] > 0]
        if not len(positive):
            committed_class = "Never"
            visible_class = "Never"
            row = None
        else:
            row = positive.iloc[0]
            committed_class = (
                "None"
                if row["committed_r"] <= 1e-12
                else "Complete"
                if row["committed_r"] >= 1 - 1e-12
                else "Partial"
            )
            visible_value = row["ever_seen_or_committed_coverage"]
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
                "committed_class": committed_class,
                "visible_class": visible_class,
                "current_preview_has_gold": bool(row is not None and row["current_preview_gold_count"] > 0),
                "first_positive_tau": float(row["tau"]) if row is not None else math.nan,
            }
        )
    return pd.DataFrame(rows)


def pass_04_first_positive(states: pd.DataFrame, output_dir: Path) -> tuple[dict, pd.DataFrame]:
    crossing = trajectory_first_positive(states)
    crossing.to_csv(output_dir / "04-first-positive-evidence.csv", index=False)
    order = ["None", "Partial", "Complete", "Never"]
    colors = [PALE_GRAY, PALE_TEAL, DARK_TEAL, CMU_RED]
    labels = ["没有", "部分", "完整", "始终未转正"]
    rows = [("仅统计已提交证据", "committed_class"), ("加入搜索预览后", "visible_class")]
    figure, axis = plt.subplots(figsize=(5.2, 1.72))
    for y, (label, column) in enumerate(rows):
        left = 0.0
        counts = crossing[column].value_counts()
        for category, color, legend_label in zip(order, colors, labels):
            share = float(counts.get(category, 0)) / len(crossing) * 100
            axis.barh(
                y,
                share,
                left=left,
                height=0.48,
                color=color,
                edgecolor=WHITE,
                linewidth=0.75,
                label=legend_label if y == 0 else None,
            )
            if share >= 6:
                text_color = WHITE if category in {"Complete", "Never"} else CHARCOAL
                axis.text(left + share / 2, y, f"{share:.1f}%", ha="center", va="center", color=text_color, fontsize=7.3)
            left += share
    axis.set_yticks([0, 1], [row[0] for row in rows])
    axis.invert_yaxis()
    axis.set_xlim(0, 100)
    axis.set_xlabel("轨迹比例")
    axis.xaxis.set_major_formatter(mpl.ticker.PercentFormatter())
    axis.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01), ncol=4, frameon=False, fontsize=7.2)
    tidy(axis, xgrid=True, ygrid=False)
    save_figure(figure, output_dir, "04-first-positive-evidence")
    summary = {
        "ever_positive": int((crossing["committed_class"] != "Never").sum()),
        "current_preview_gold_at_first_positive": int(crossing["current_preview_has_gold"].sum()),
        "committed_classes": {key: int(value) for key, value in crossing["committed_class"].value_counts().items()},
        "visible_classes": {key: int(value) for key, value in crossing["visible_class"].value_counts().items()},
    }
    return summary, crossing


def pass_05_evidence_gain(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    transitions = states[states["decision_step"] > 1].copy().reset_index(drop=True)
    committed_gain = transitions["delta_committed_r"] > 1e-12
    visible_gain = transitions["delta_ever_seen_or_committed_coverage"] > 1e-12
    transitions["category"] = np.select(
        [
            visible_gain & ~committed_gain,
            committed_gain & ~visible_gain,
            committed_gain & visible_gain,
        ],
        ["Preview only", "Commit already seen", "Commit newly seen"],
        default="No new gold",
    )
    categories = ["Preview only", "Commit already seen", "Commit newly seen"]
    for category in categories:
        transitions[f"is_{category}"] = (transitions["category"] == category).astype(float)
    round_dummies = pd.get_dummies(transitions["round"], drop_first=True, dtype=float)
    x = np.column_stack(
        [
            np.ones(len(transitions)),
            transitions[[f"is_{category}" for category in categories]].to_numpy(dtype=float),
            transitions["prev_native_s"].to_numpy(dtype=float),
            transitions["prev_committed_r"].to_numpy(dtype=float),
            transitions["tau"].to_numpy(dtype=float),
            np.square(transitions["tau"].to_numpy(dtype=float)),
            transitions["gold_hop_count"].to_numpy(dtype=float),
            round_dummies.to_numpy(dtype=float),
        ]
    )
    y = transitions["delta_native_s"].to_numpy(dtype=float)
    estimate, low, high = clustered_ols(transitions, x, y, rng, draws)
    rows = []
    for index, category in enumerate(categories, start=1):
        subset = transitions[transitions["category"] == category]
        rows.append(
            {
                "event": category,
                "transitions": int(len(subset)),
                "raw_mean_delta_s": float(subset["delta_native_s"].mean()),
                "adjusted_delta_vs_no_gain": float(estimate[index]),
                "ci_low": float(low[index]),
                "ci_high": float(high[index]),
            }
        )
    baseline = transitions[transitions["category"] == "No new gold"]
    table = pd.DataFrame(rows)
    table.to_csv(output_dir / "05-evidence-gain-response.csv", index=False)

    figure, axis = plt.subplots(figsize=(5.0, 2.75))
    y_positions = np.arange(len(table))[::-1]
    values = table["adjusted_delta_vs_no_gain"].to_numpy()
    axis.errorbar(
        values,
        y_positions,
        xerr=np.vstack([values - table["ci_low"], table["ci_high"] - values]),
        fmt="o",
        color=CMU_RED,
        ecolor=CMU_RED,
        markersize=5,
        linewidth=1.2,
        capsize=2.5,
    )
    axis.axvline(0, color=CHARCOAL, linewidth=0.8)
    axis.set_yticks(y_positions, ["只在搜索预览中新出现", "包内新增此前匹配过的证据", "包内新增此前未匹配的证据"])
    axis.set_xlabel("相对“没有新证据”的 S 变化")
    axis.set_ylim(-0.6, len(table) - 0.4)
    tidy(axis, xgrid=True, ygrid=False)
    save_figure(figure, output_dir, "05-evidence-gain-response")
    return {
        "no_new_gold": {
            "transitions": int(len(baseline)),
            "raw_mean_delta_s": float(baseline["delta_native_s"].mean()),
        },
        "effects": rows,
    }


def grouped_rate_draws(
    frame: pd.DataFrame,
    cell_columns: list[str],
    outcome: str,
    rng: np.random.Generator,
    draws: int,
) -> tuple[pd.DataFrame, dict[tuple, np.ndarray]]:
    questions = sorted(frame["question_id"].unique())
    weights = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    observed_rows = []
    draw_map = {}
    levels = [sorted(frame[column].dropna().unique()) for column in cell_columns]
    for cell in itertools.product(*levels):
        mask = np.ones(len(frame), dtype=bool)
        for column, value in zip(cell_columns, cell):
            mask &= frame[column].to_numpy() == value
        subset = frame[mask]
        totals = subset.groupby("question_id").size().reindex(questions, fill_value=0).to_numpy(dtype=float)
        successes = subset.groupby("question_id")[outcome].sum().reindex(questions, fill_value=0).to_numpy(dtype=float)
        numerator = np.einsum("bq,q->b", weights, successes)
        denominator = np.einsum("bq,q->b", weights, totals)
        rates = np.divide(numerator, denominator, out=np.full(draws, np.nan), where=denominator > 0)
        estimate = float(subset[outcome].mean()) if len(subset) else math.nan
        low, high = percentile(rates)
        observed_rows.append(
            {
                **{column: value for column, value in zip(cell_columns, cell)},
                "states": int(len(subset)),
                "successes": int(subset[outcome].sum()),
                "rate": estimate,
                "ci_low": low,
                "ci_high": high,
            }
        )
        draw_map[cell] = rates
    return pd.DataFrame(observed_rows), draw_map


def pass_06_reversals(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    at_risk = states[states["prev_native_positive"]].copy().reset_index(drop=True)
    at_risk["preview_state"] = np.where(at_risk["current_preview_any"], "有 gold 预览", "无 gold 预览")
    at_risk["coverage_state"] = np.where(at_risk["full_committed"], "R 完整", "R 不完整")
    table, rate_draws = grouped_rate_draws(
        at_risk, ["coverage_state", "preview_state"], "reversal", rng, draws
    )
    table.to_csv(output_dir / "06-reversal-by-preview.csv", index=False)

    round_dummies = pd.get_dummies(at_risk["round"], drop_first=True, dtype=float)
    x = np.column_stack(
        [
            np.ones(len(at_risk)),
            at_risk["current_preview_any"].astype(float),
            at_risk["full_committed"].astype(float),
            at_risk["tau"].astype(float),
            at_risk["prev_native_s"].astype(float),
            round_dummies.to_numpy(dtype=float),
        ]
    )
    y = at_risk["reversal"].to_numpy(dtype=float)
    estimate, low, high = clustered_ols(at_risk, x, y, rng, draws)

    figure, axis = plt.subplots(figsize=(4.65, 3.0))
    x_positions = np.arange(2)
    for preview_state, color, marker, offset in [
        ("无 gold 预览", CMU_RED, "o", -0.07),
        ("有 gold 预览", DARK_TEAL, "s", 0.07),
    ]:
        subset = table[table["preview_state"] == preview_state].set_index("coverage_state")
        ordered = subset.loc[["R 不完整", "R 完整"]]
        values = ordered["rate"].to_numpy()
        axis.errorbar(
            x_positions + offset,
            values,
            yerr=np.vstack([values - ordered["ci_low"], ordered["ci_high"] - values]),
            fmt=marker,
            color=color,
            label=preview_state,
            markersize=5,
            linewidth=1.2,
            capsize=2.5,
        )
    axis.set_xticks(x_positions, ["R 不完整", "R 完整"])
    axis.set_ylabel("S 从正值反转为非正的比例")
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.set_ylim(0, 0.30)
    axis.legend(
        frameon=False,
        loc="lower center",
        bbox_to_anchor=(0.5, 1.01),
        ncol=2,
    )
    tidy(axis)
    save_figure(figure, output_dir, "06-reversal-by-preview")
    return {
        "states_at_risk": int(len(at_risk)),
        "reversals": int(at_risk["reversal"].sum()),
        "adjusted_preview_present_risk_difference": {
            "estimate": float(estimate[1]),
            "ci_low": float(low[1]),
            "ci_high": float(high[1]),
        },
        "cells": table.to_dict(orient="records"),
    }


def ridge_oof_predictions(
    frame: pd.DataFrame,
    feature_matrix: np.ndarray,
    folds: np.ndarray,
    ridge: float = 1e-3,
) -> np.ndarray:
    y = frame["native_s"].to_numpy(dtype=float)
    predictions = np.zeros(len(frame), dtype=float)
    for fold in np.unique(folds):
        train = folds != fold
        test = ~train
        x_train = feature_matrix[train]
        x_test = feature_matrix[test]
        mean = x_train.mean(axis=0)
        scale = x_train.std(axis=0)
        scale[scale < 1e-10] = 1
        design_train = np.column_stack([np.ones(train.sum()), (x_train - mean) / scale])
        design_test = np.column_stack([np.ones(test.sum()), (x_test - mean) / scale])
        penalty = np.eye(design_train.shape[1]) * ridge
        penalty[0, 0] = 0
        gram = np.einsum("ni,nj->ij", design_train, design_train)
        right = np.einsum("ni,n->i", design_train, y[train])
        beta = np.linalg.solve(gram + penalty, right)
        predictions[test] = np.einsum("ni,i->n", design_test, beta)
    return predictions


def r2_score(y: np.ndarray, prediction: np.ndarray, weights: np.ndarray | None = None) -> float:
    y = np.asarray(y, dtype=float)
    prediction = np.asarray(prediction, dtype=float)
    if weights is None:
        weights = np.ones(len(y), dtype=float)
    weights = np.asarray(weights, dtype=float)
    mean = np.average(y, weights=weights)
    sst = np.sum(weights * np.square(y - mean))
    sse = np.sum(weights * np.square(y - prediction))
    return float(1 - sse / sst)


def ordered_subset(keys: list[str], subset: Iterable[str]) -> tuple[str, ...]:
    selected = set(subset)
    return tuple(key for key in keys if key in selected)


def shapley_from_values(values: dict[tuple[str, ...], float], keys: list[str]) -> dict[str, float]:
    contributions = {key: [] for key in keys}
    for permutation in itertools.permutations(keys):
        current: tuple[str, ...] = ()
        current_value = values[current]
        for key in permutation:
            nxt = ordered_subset(keys, (*current, key))
            next_value = values[nxt]
            contributions[key].append(next_value - current_value)
            current, current_value = nxt, next_value
    return {key: float(np.mean(increments)) for key, increments in contributions.items()}


def pass_07_predictive_decomposition(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    frame = states.copy().reset_index(drop=True)
    questions = np.array(sorted(frame["question_id"].unique()))
    shuffled = questions.copy()
    rng.shuffle(shuffled)
    fold_map = {question: index % 10 for index, question in enumerate(shuffled)}
    folds = frame["question_id"].map(fold_map).to_numpy(dtype=int)
    round_dummies = pd.get_dummies(frame["round"], drop_first=True, dtype=float).to_numpy()
    base = np.column_stack([round_dummies, frame["gold_hop_count"].to_numpy(dtype=float)])
    groups = {
        "Time": np.column_stack([frame["tau"], frame["tau"] ** 2, frame["tau"] ** 3]),
        "Committed": np.column_stack([frame["committed_r"], frame["committed_r"] ** 2]),
        "Visible": np.column_stack(
            [
                frame["current_preview_coverage"],
                frame["current_preview_coverage"] ** 2,
                frame["ever_seen_or_committed_coverage"],
                frame["ever_seen_or_committed_coverage"] ** 2,
                frame["current_preview_coverage"] * frame["committed_r"],
            ]
        ),
    }
    keys = list(groups)
    y = frame["native_s"].to_numpy(dtype=float)
    predictions: dict[tuple[str, ...], np.ndarray] = {}
    values: dict[tuple[str, ...], float] = {}
    for size in range(len(keys) + 1):
        for subset in itertools.combinations(keys, size):
            matrix = np.concatenate([base] + [groups[key] for key in subset], axis=1)
            predictions[subset] = ridge_oof_predictions(frame, matrix, folds)
            values[subset] = r2_score(y, predictions[subset])
    contributions = shapley_from_values(values, keys)

    question_index = {question: index for index, question in enumerate(questions)}
    n_by_q = np.zeros(len(questions))
    sum_y_by_q = np.zeros(len(questions))
    sum_y2_by_q = np.zeros(len(questions))
    sse_by_subset = {subset: np.zeros(len(questions)) for subset in predictions}
    for question, subset_frame in frame.groupby("question_id"):
        position = question_index[question]
        idx = subset_frame.index.to_numpy()
        local_y = y[idx]
        n_by_q[position] = len(idx)
        sum_y_by_q[position] = local_y.sum()
        sum_y2_by_q[position] = np.square(local_y).sum()
        for subset, prediction in predictions.items():
            sse_by_subset[subset][position] = np.square(local_y - prediction[idx]).sum()
    weights = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    total_n = np.einsum("bq,q->b", weights, n_by_q)
    total_y = np.einsum("bq,q->b", weights, sum_y_by_q)
    total_y2 = np.einsum("bq,q->b", weights, sum_y2_by_q)
    sst = total_y2 - np.square(total_y) / total_n
    value_draws = {
        subset: 1 - np.einsum("bq,q->b", weights, sse) / sst
        for subset, sse in sse_by_subset.items()
    }
    contribution_draws = {key: [] for key in keys}
    for draw in range(draws):
        draw_values = {subset: float(series[draw]) for subset, series in value_draws.items()}
        draw_contribution = shapley_from_values(draw_values, keys)
        for key in keys:
            contribution_draws[key].append(draw_contribution[key])
    labels = {"Time": "检索进度", "Committed": "已提交证据", "Visible": "可见预览与累计可见证据"}
    rows = []
    for key in keys:
        low, high = percentile(np.asarray(contribution_draws[key]))
        rows.append(
            {
                "feature_group": key,
                "label": labels[key],
                "shapley_r2": contributions[key],
                "ci_low": low,
                "ci_high": high,
            }
        )
    table = pd.DataFrame(rows).sort_values("shapley_r2", ascending=True)
    model_rows = [
        {"feature_groups": "+".join(subset) if subset else "Base", "oof_r2": value}
        for subset, value in values.items()
    ]
    pd.DataFrame(model_rows).to_csv(output_dir / "07-predictive-models.csv", index=False)
    table.to_csv(output_dir / "07-predictive-r2-decomposition.csv", index=False)

    figure, axis = plt.subplots(figsize=(5.0, 2.55))
    y_positions = np.arange(len(table))
    value = table["shapley_r2"].to_numpy()
    axis.errorbar(
        value,
        y_positions,
        xerr=np.vstack([value - table["ci_low"], table["ci_high"] - value]),
        fmt="o",
        color=DARK_TEAL,
        ecolor=DARK_TEAL,
        markersize=5.2,
        linewidth=1.2,
        capsize=2.5,
    )
    axis.axvline(0, color=CHARCOAL, linewidth=0.8)
    axis.set_yticks(y_positions, table["label"])
    axis.set_xlabel("对跨题目预测 R² 的平均贡献")
    tidy(axis, xgrid=True, ygrid=False)
    save_figure(figure, output_dir, "07-predictive-r2-decomposition")
    full_subset = tuple(keys)
    return {
        "base_oof_r2": values[()],
        "full_oof_r2": values[full_subset],
        "shapley_contributions": rows,
        "protocol": "10-fold cross-validation grouped by benchmark question; bootstrap over question IDs",
    }


def pass_08_terminal_gate(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    terminal = states[states["terminal"]].copy().reset_index(drop=True)
    terminal["s_state"] = np.where(terminal["native_positive"], "S 为正", "S 非正")
    terminal["r_state"] = np.where(terminal["full_committed"], "R 完整", "R 不完整")
    table, rate_draws = grouped_rate_draws(terminal, ["r_state", "s_state"], "correct", rng, draws)
    table.to_csv(output_dir / "08-terminal-evidence-gate.csv", index=False)
    incomplete_effect = rate_draws[("R 不完整", "S 为正")] - rate_draws[("R 不完整", "S 非正")]
    full_effect = rate_draws[("R 完整", "S 为正")] - rate_draws[("R 完整", "S 非正")]
    interaction = full_effect - incomplete_effect
    contrasts = {}
    for name, values in [
        ("s_effect_when_incomplete", incomplete_effect),
        ("s_effect_when_full", full_effect),
        ("interaction", interaction),
    ]:
        low, high = percentile(values)
        contrasts[name] = {"estimate": float(np.nanmean(values)), "ci_low": low, "ci_high": high}

    figure, axis = plt.subplots(figsize=(4.8, 3.15))
    x_positions = np.arange(2)
    for s_state, color, marker, offset in [
        ("S 非正", MID_GRAY, "o", -0.06),
        ("S 为正", CMU_RED, "s", 0.06),
    ]:
        subset = table[table["s_state"] == s_state].set_index("r_state")
        ordered = subset.loc[["R 不完整", "R 完整"]]
        value = ordered["rate"].to_numpy()
        axis.plot(x_positions + offset, value, color=color, linewidth=1.25, alpha=0.85)
        axis.errorbar(
            x_positions + offset,
            value,
            yerr=np.vstack([value - ordered["ci_low"], ordered["ci_high"] - value]),
            fmt=marker,
            color=color,
            markersize=5,
            linewidth=1.15,
            capsize=2.5,
            label=s_state,
        )
    axis.set_xticks(x_positions, ["R 不完整", "R 完整"])
    axis.set_ylabel("最终答案正确率")
    axis.set_ylim(0, 1)
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.legend(frameon=False, loc="upper left")
    tidy(axis)
    save_figure(figure, output_dir, "08-terminal-evidence-gate")
    return {"cells": table.to_dict(orient="records"), "contrasts": contrasts}


def pass_09_within_question(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    terminal = states[states["terminal"]].copy()
    rows = []
    for question, group in terminal.groupby("question_id"):
        group = group.reset_index(drop=True)
        for left, right in itertools.combinations(range(len(group)), 2):
            first = group.iloc[left]
            second = group.iloc[right]
            if bool(first["full_committed"]) == bool(second["full_committed"]):
                continue
            full = second if bool(second["full_committed"]) else first
            incomplete = first if bool(second["full_committed"]) else second
            rows.append(
                {
                    "question_id": question,
                    "incomplete_correct": bool(incomplete["correct"]),
                    "full_correct": bool(full["correct"]),
                    "paired_difference": float(full["correct"]) - float(incomplete["correct"]),
                }
            )
    pairs = pd.DataFrame(rows)
    pairs.to_csv(output_dir / "09-within-question-pairs.csv", index=False)
    questions = sorted(pairs["question_id"].unique())
    totals = pairs.groupby("question_id").size().reindex(questions, fill_value=0).to_numpy(dtype=float)
    differences = pairs.groupby("question_id")["paired_difference"].sum().reindex(questions, fill_value=0).to_numpy(dtype=float)
    weights = rng.multinomial(
        len(questions), np.full(len(questions), 1 / len(questions)), size=draws
    )
    draw_effect = np.einsum("bq,q->b", weights, differences) / np.einsum(
        "bq,q->b", weights, totals
    )
    low, high = percentile(draw_effect)
    estimate = float(pairs["paired_difference"].mean())

    matrix = np.zeros((2, 2), dtype=int)
    for _, row in pairs.iterrows():
        matrix[int(row["incomplete_correct"]), int(row["full_correct"])] += 1
    figure, axis = plt.subplots(figsize=(3.75, 3.25))
    sns.heatmap(
        matrix,
        annot=True,
        fmt="d",
        cmap=mpl.colors.LinearSegmentedColormap.from_list("cmu_matrix", [WHITE, PALE_TEAL, DARK_TEAL]),
        cbar=False,
        square=True,
        linewidths=1.0,
        linecolor=WHITE,
        annot_kws={"fontsize": 12},
        ax=axis,
    )
    axis.set_xticklabels(["答错", "答对"])
    axis.set_yticklabels(["答错", "答对"], rotation=0)
    axis.set_xlabel("同题运行：R 完整")
    axis.set_ylabel("同题运行：R 不完整")
    save_figure(figure, output_dir, "09-within-question-pairs")
    return {
        "discordant_coverage_pairs": int(len(pairs)),
        "paired_accuracy_difference": estimate,
        "ci_low": low,
        "ci_high": high,
        "outcome_matrix_rows_incomplete_columns_full": matrix.tolist(),
    }


def expected_top_k_accuracy(frame: pd.DataFrame, key_columns: list[str], k: int) -> float:
    grouped = (
        frame.groupby(key_columns, dropna=False)["correct"]
        .agg(["sum", "count"])
        .reset_index()
        .sort_values(key_columns, ascending=[False] * len(key_columns))
    )
    remaining = float(k)
    correct = 0.0
    for _, row in grouped.iterrows():
        take = min(remaining, float(row["count"]))
        correct += take * float(row["sum"]) / float(row["count"])
        remaining -= take
        if remaining <= 1e-12:
            break
    return correct / k


def pass_10_selective_accuracy(
    states: pd.DataFrame, output_dir: Path, rng: np.random.Generator, draws: int
) -> dict:
    terminal = states[states["terminal"]].copy().reset_index(drop=True)
    terminal["full_gate"] = terminal["full_committed"].astype(int)
    methods = {
        "J": ["explicit_j"],
        "S": ["native_s"],
        "R gate + S": ["full_gate", "native_s"],
    }
    coverages = np.arange(0.10, 1.001, 0.01)
    rows = []
    for method, columns in methods.items():
        for coverage in coverages:
            k = max(1, int(round(len(terminal) * coverage)))
            rows.append(
                {
                    "method": method,
                    "retained_fraction": coverage,
                    "retained": k,
                    "accuracy": expected_top_k_accuracy(terminal, columns, k),
                }
            )
    curves = pd.DataFrame(rows)
    curves.to_csv(output_dir / "10-selective-accuracy.csv", index=False)

    question_groups = {question: group for question, group in terminal.groupby("question_id")}
    questions = np.array(sorted(question_groups))
    selected_coverages = [0.25, 0.50]
    bootstrap_summary = {}
    bootstrap_draws = min(draws, 2000)
    collected = {(method, coverage): [] for method in methods for coverage in selected_coverages}
    for _ in range(bootstrap_draws):
        selected = rng.choice(questions, size=len(questions), replace=True)
        sample = pd.concat([question_groups[question] for question in selected], ignore_index=True)
        for method, columns in methods.items():
            for coverage in selected_coverages:
                k = max(1, int(round(len(sample) * coverage)))
                collected[(method, coverage)].append(expected_top_k_accuracy(sample, columns, k))
    for (method, coverage), values in collected.items():
        low, high = percentile(np.asarray(values))
        point = curves[(curves["method"] == method) & np.isclose(curves["retained_fraction"], coverage)]["accuracy"].iloc[0]
        bootstrap_summary[f"{method}@{coverage:.2f}"] = {
            "accuracy": float(point),
            "ci_low": low,
            "ci_high": high,
        }

    figure, axis = plt.subplots(figsize=(5.1, 3.35))
    styles = {
        "J": (MID_GRAY, "--"),
        "S": (TEAL, "-"),
        "R gate + S": (CMU_RED, "-"),
    }
    labels = {"J": "只用 J", "S": "只用 S", "R gate + S": "先要求 R 完整，再按 S 排序"}
    for method in methods:
        subset = curves[curves["method"] == method]
        color, linestyle = styles[method]
        axis.plot(
            subset["retained_fraction"],
            subset["accuracy"],
            color=color,
            linestyle=linestyle,
            linewidth=1.9,
            label=labels[method],
        )
    axis.axhline(terminal["correct"].mean(), color=LIGHT_GRAY, linewidth=0.9)
    axis.set_xlim(0.10, 1.0)
    axis.set_ylim(0.35, 1.0)
    axis.set_xlabel("保留作答的轨迹比例")
    axis.set_ylabel("保留轨迹的答案正确率")
    axis.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    axis.legend(frameon=False, loc="upper right")
    tidy(axis)
    save_figure(figure, output_dir, "10-selective-accuracy")
    return {
        "overall_accuracy": float(terminal["correct"].mean()),
        "selected_points": bootstrap_summary,
        "tie_handling": "expected accuracy under random selection within exact score ties",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--experiment-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
    )
    parser.add_argument(
        "--visible-context",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
    )
    parser.add_argument("--bootstrap-draws", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260913)
    args = parser.parse_args()
    experiment_dir = args.experiment_dir.resolve()
    visible_context = (
        args.visible_context.resolve()
        if args.visible_context
        else experiment_dir / "analysis-rs-v2/three-rounds/deep-dive/states-with-visible-context.csv"
    )
    output_dir = (
        args.output_dir.resolve()
        if args.output_dir
        else experiment_dir / "analysis-rs-v3/ten-pass"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    configure_style()
    rng = np.random.default_rng(args.seed)
    raw, states = load_data(experiment_dir, visible_context)

    summary: dict[str, object] = {
        "analysis_version": "ten-pass-v1",
        "sample": {
            "questions": 100,
            "trajectories": 300,
            "states": 2150,
            "state_replica_rows": 4300,
            "j_samples": int(raw["j_sample_count"].sum()),
            "final_correct": int(states[states["terminal"]]["correct"].sum()),
        },
        "resampling": {
            "unit": "benchmark question",
            "draws": args.bootstrap_draws,
            "seed": args.seed,
        },
    }
    summary["pass_01_measurement_reliability"] = pass_01_reliability(raw, output_dir)
    summary["pass_02_j_negative_control"] = pass_02_j_negative_control(states, output_dir)
    pass_03, _events = pass_03_event_ordering(states, output_dir)
    summary["pass_03_event_ordering"] = pass_03
    pass_04, _crossing = pass_04_first_positive(states, output_dir)
    summary["pass_04_first_positive"] = pass_04
    summary["pass_05_evidence_gain"] = pass_05_evidence_gain(states, output_dir, rng, args.bootstrap_draws)
    summary["pass_06_reversals"] = pass_06_reversals(states, output_dir, rng, args.bootstrap_draws)
    summary["pass_07_predictive_decomposition"] = pass_07_predictive_decomposition(
        states, output_dir, rng, args.bootstrap_draws
    )
    summary["pass_08_terminal_gate"] = pass_08_terminal_gate(states, output_dir, rng, args.bootstrap_draws)
    summary["pass_09_within_question"] = pass_09_within_question(states, output_dir, rng, args.bootstrap_draws)
    summary["pass_10_selective_accuracy"] = pass_10_selective_accuracy(
        states, output_dir, rng, args.bootstrap_draws
    )

    with (output_dir / "ten-pass-summary.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2, default=json_number)
    print(json.dumps(summary["sample"], ensure_ascii=False))
    print(f"wrote ten-pass analysis to {output_dir}")


if __name__ == "__main__":
    main()
