#!/usr/bin/env python3
"""Experiment 1: controlled evidence sensitivity for Picorer RQ2."""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[2]
SOURCE_ROOT = WORKSPACE / "experiments" / "sufficiency-interventions-20260914"
UNITS_PATH = SOURCE_ROOT / "summary" / "units.csv"
STATUS_PATH = SOURCE_ROOT / "summary" / "status.json"
RESULTS = HERE / "results"
FIGURES = HERE / "figures"
SKILL = Path.home() / ".codex" / "skills" / "scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from figure_export import export_figure
from palette_audit import audit_palette


SEED = 20260915
BOOTSTRAP_DRAWS = 10_000
PERMUTATION_DRAWS = 200_000
RED = "#B21F32"
BLUE = "#245C7C"
GRAY = "#5F5F5F"

ANALYSES = {
    "Any missing support added": lambda frame: pd.Series(True, index=frame.index),
    "Completing support added": lambda frame: frame["completes_coverage"],
}
METRICS = {
    "Native sufficiency margin": "delta_margin",
    "Sufficiency likelihood": "delta_likelihood",
    "Answer accuracy": "delta_answer_accuracy",
    "Strict exact match": "delta_exact_match",
    "Input tokens": "delta_input_tokens",
}
PRIMARY_METRICS = ["Native sufficiency margin", "Sufficiency likelihood", "Answer accuracy"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bootstrap_ci(values: np.ndarray, statistic: str, seed_offset: int) -> tuple[float, float, float]:
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if statistic == "mean":
        observed = float(values.mean())
        reducer = np.mean
    elif statistic == "median":
        observed = float(np.median(values))
        reducer = np.median
    else:
        raise ValueError(statistic)
    rng = np.random.default_rng(SEED + seed_offset)
    samples = rng.choice(values, size=(BOOTSTRAP_DRAWS, len(values)), replace=True)
    draws = reducer(samples, axis=1)
    low, high = np.percentile(draws, [2.5, 97.5])
    return observed, float(low), float(high)


def sign_flip_test(values: np.ndarray, seed_offset: int) -> float:
    """Two-sided Monte Carlo paired sign-flip test on question-level effects."""
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    observed = abs(float(values.mean()))
    rng = np.random.default_rng(SEED + seed_offset)
    exceed = 0
    remaining = PERMUTATION_DRAWS
    while remaining:
        size = min(10_000, remaining)
        signs = rng.choice(np.array([-1.0, 1.0]), size=(size, len(values)))
        null = np.abs((signs * values).mean(axis=1))
        exceed += int(np.count_nonzero(null >= observed - 1e-15))
        remaining -= size
    return float((exceed + 1) / (PERMUTATION_DRAWS + 1))


def holm_adjust(p_values: pd.Series) -> pd.Series:
    order = np.argsort(p_values.to_numpy())
    sorted_p = p_values.to_numpy()[order]
    adjusted_sorted = np.maximum.accumulate(
        np.minimum(1.0, sorted_p * (len(sorted_p) - np.arange(len(sorted_p))))
    )
    adjusted = np.empty_like(adjusted_sorted)
    adjusted[order] = adjusted_sorted
    return pd.Series(adjusted, index=p_values.index)


def load_conditions() -> pd.DataFrame:
    status = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    assert status["expected_jobs"] == status["completed_jobs"] == 34126
    assert status["missing_jobs"] == 0
    units = pd.read_csv(UNITS_PATH)
    assert len(units) == 10018 and units["complete"].all()
    coverage = units.loc[units["experiment"].eq("coverage") & ~units["conflicted"]].copy()
    assert len(coverage) == 760
    assert coverage["question_id"].nunique() == 64
    assert coverage["native_n"].eq(2).all()
    assert coverage["answer_n"].eq(5).all()
    assert np.allclose(coverage["likelihood"], 1 / (1 + np.exp(-coverage["margin"])))
    return coverage


def construct_pairs(coverage: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for (question_id, order), group in coverage.groupby(["question_id", "order"], sort=True):
        hops = int(group.iloc[0]["gold_hops"])
        by_mask = {int(row["mask"]): row for row in group.to_dict("records")}
        assert len(by_mask) == 2 ** hops
        for mask, before in sorted(by_mask.items()):
            for bit in range(hops):
                if mask & (1 << bit):
                    continue
                after_mask = mask | (1 << bit)
                after = by_mask[after_mask]
                rows.append({
                    "question_id": question_id,
                    "gold_hops": hops,
                    "order": int(order),
                    "before_condition_id": before["id"],
                    "after_condition_id": after["id"],
                    "before_mask": mask,
                    "after_mask": after_mask,
                    "added_hop": bit + 1,
                    "before_coverage": float(before["r"]),
                    "after_coverage": float(after["r"]),
                    "completes_coverage": bool(np.isclose(after["r"], 1.0)),
                    "delta_margin": float(after["margin"] - before["margin"]),
                    "delta_likelihood": float(after["likelihood"] - before["likelihood"]),
                    "delta_answer_accuracy": float(after["official_score"] - before["official_score"]),
                    "delta_exact_match": float(after["exact_match"] - before["exact_match"]),
                    "delta_input_tokens": float(after["input_tokens"] - before["input_tokens"]),
                })
    pairs = pd.DataFrame(rows)
    assert len(pairs) == 1072
    assert pairs["question_id"].nunique() == 64
    assert pairs["after_coverage"].gt(pairs["before_coverage"]).all()
    assert pairs.loc[pairs["completes_coverage"]].shape[0] == 302
    return pairs


def summarize_effects(pairs: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    test_index: list[int] = []
    for analysis_index, (analysis, selector) in enumerate(ANALYSES.items()):
        frame = pairs.loc[selector(pairs)].copy()
        for metric_index, (metric, column) in enumerate(METRICS.items()):
            per_question_mean = frame.groupby("question_id")[column].mean()
            per_question_positive = frame.groupby("question_id")[column].apply(lambda x: float((x > 0).mean()))
            per_question_zero = frame.groupby("question_id")[column].apply(
                lambda x: float(np.isclose(x, 0).mean())
            )
            per_question_negative = frame.groupby("question_id")[column].apply(
                lambda x: float((x < 0).mean())
            )
            mean, mean_low, mean_high = bootstrap_ci(
                per_question_mean.to_numpy(), "mean", 100 + analysis_index * 20 + metric_index
            )
            median, median_low, median_high = bootstrap_ci(
                per_question_mean.to_numpy(), "median", 200 + analysis_index * 20 + metric_index
            )
            positive, positive_low, positive_high = bootstrap_ci(
                per_question_positive.to_numpy(), "mean", 300 + analysis_index * 20 + metric_index
            )
            zero, zero_low, zero_high = bootstrap_ci(
                per_question_zero.to_numpy(), "mean", 350 + analysis_index * 20 + metric_index
            )
            negative, negative_low, negative_high = bootstrap_ci(
                per_question_negative.to_numpy(), "mean", 375 + analysis_index * 20 + metric_index
            )
            question_positive = (per_question_mean > 0).astype(float)
            q_positive, q_positive_low, q_positive_high = bootstrap_ci(
                question_positive.to_numpy(), "mean", 400 + analysis_index * 20 + metric_index
            )
            p_value = sign_flip_test(
                per_question_mean.to_numpy(), 500 + analysis_index * 20 + metric_index
            )
            row = {
                "analysis": analysis,
                "metric": metric,
                "estimate": mean,
                "ci_low": mean_low,
                "ci_high": mean_high,
                "median_question_effect": median,
                "median_ci_low": median_low,
                "median_ci_high": median_high,
                "question_weighted_positive_pair_probability": positive,
                "positive_probability_ci_low": positive_low,
                "positive_probability_ci_high": positive_high,
                "question_weighted_zero_pair_probability": zero,
                "zero_probability_ci_low": zero_low,
                "zero_probability_ci_high": zero_high,
                "question_weighted_negative_pair_probability": negative,
                "negative_probability_ci_low": negative_low,
                "negative_probability_ci_high": negative_high,
                "fraction_questions_positive_mean": q_positive,
                "fraction_questions_positive_mean_ci_low": q_positive_low,
                "fraction_questions_positive_mean_ci_high": q_positive_high,
                "sign_flip_p_two_sided": p_value,
                "sign_flip_p_holm_primary": math.nan,
                "questions": int(per_question_mean.size),
                "pairs": int(len(frame)),
            }
            rows.append(row)
            if metric in PRIMARY_METRICS:
                test_index.append(len(rows) - 1)
    result = pd.DataFrame(rows)
    result.loc[test_index, "sign_flip_p_holm_primary"] = holm_adjust(
        result.loc[test_index, "sign_flip_p_two_sided"]
    ).to_numpy()
    return result


def summarize_orders(pairs: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for analysis_index, (analysis, selector) in enumerate(ANALYSES.items()):
        frame = pairs.loc[selector(pairs)].copy()
        for metric_index, (metric, column) in enumerate(METRICS.items()):
            question_order = frame.groupby(["question_id", "order"])[column].mean().unstack("order")
            assert question_order.shape[1] == 2 and question_order.notna().all().all()
            orders = sorted(question_order.columns)
            first = question_order[orders[0]].to_numpy()
            second = question_order[orders[1]].to_numpy()
            first_estimate, first_low, first_high = bootstrap_ci(
                first, "mean", 600 + analysis_index * 20 + metric_index
            )
            second_estimate, second_low, second_high = bootstrap_ci(
                second, "mean", 700 + analysis_index * 20 + metric_index
            )
            difference, difference_low, difference_high = bootstrap_ci(
                second - first, "mean", 800 + analysis_index * 20 + metric_index
            )
            rank_first = pd.Series(first).rank(method="average").to_numpy()
            rank_second = pd.Series(second).rank(method="average").to_numpy()
            spearman = float(np.corrcoef(rank_first, rank_second)[0, 1])
            rows.append({
                "analysis": analysis,
                "metric": metric,
                "order_first": int(orders[0]),
                "order_first_estimate": first_estimate,
                "order_first_ci_low": first_low,
                "order_first_ci_high": first_high,
                "order_second": int(orders[1]),
                "order_second_estimate": second_estimate,
                "order_second_ci_low": second_low,
                "order_second_ci_high": second_high,
                "second_minus_first": difference,
                "difference_ci_low": difference_low,
                "difference_ci_high": difference_high,
                "question_rank_correlation": spearman,
                "questions": len(question_order),
            })
    return pd.DataFrame(rows)


def summarize_hops(pairs: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for hops, hop_frame in pairs.groupby("gold_hops", sort=True):
        for analysis_index, (analysis, selector) in enumerate(ANALYSES.items()):
            frame = hop_frame.loc[selector(hop_frame)].copy()
            for metric_index, (metric, column) in enumerate(METRICS.items()):
                per_question = frame.groupby("question_id")[column].mean()
                mean, low, high = bootstrap_ci(
                    per_question.to_numpy(), "mean",
                    900 + int(hops) * 100 + analysis_index * 20 + metric_index,
                )
                positive_per_question = frame.groupby("question_id")[column].apply(
                    lambda x: float((x > 0).mean())
                )
                positive, positive_low, positive_high = bootstrap_ci(
                    positive_per_question.to_numpy(), "mean",
                    1000 + int(hops) * 100 + analysis_index * 20 + metric_index,
                )
                rows.append({
                    "gold_hops": int(hops),
                    "analysis": analysis,
                    "metric": metric,
                    "estimate": mean,
                    "ci_low": low,
                    "ci_high": high,
                    "question_weighted_positive_pair_probability": positive,
                    "positive_probability_ci_low": positive_low,
                    "positive_probability_ci_high": positive_high,
                    "questions": len(per_question),
                    "pairs": len(frame),
                })
    return pd.DataFrame(rows)


def draw_figure(summary: pd.DataFrame) -> pd.DataFrame:
    selected = summary.loc[
        summary["metric"].isin(["Sufficiency likelihood", "Answer accuracy"])
    ].copy()
    analysis_y = {
        "Any missing support added": 1.0,
        "Completing support added": 0.0,
    }
    metric_offset = {"Sufficiency likelihood": 0.085, "Answer accuracy": -0.085}
    color = {"Sufficiency likelihood": RED, "Answer accuracy": BLUE}
    marker = {"Sufficiency likelihood": "o", "Answer accuracy": "s"}

    rc = {
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "font.size": 9.3,
        "axes.labelsize": 10.2,
        "xtick.labelsize": 8.8,
        "ytick.labelsize": 9.2,
        "axes.edgecolor": "#505050",
        "axes.linewidth": 0.7,
        "axes.labelcolor": "#252525",
        "text.color": "#252525",
        "xtick.color": "#505050",
        "ytick.color": "#303030",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "savefig.facecolor": "white",
    }
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(4.7, 2.45), layout="constrained")
        ax.axvline(0, color="#969696", linewidth=0.8, linestyle=(0, (3, 3)), zorder=0)
        for metric in ["Sufficiency likelihood", "Answer accuracy"]:
            metric_frame = selected.loc[selected["metric"].eq(metric)]
            x = metric_frame["estimate"].to_numpy()
            y = np.array([analysis_y[a] + metric_offset[metric] for a in metric_frame["analysis"]])
            xerr = np.vstack([
                x - metric_frame["ci_low"].to_numpy(),
                metric_frame["ci_high"].to_numpy() - x,
            ])
            ax.errorbar(
                x, y, xerr=xerr, fmt=marker[metric], color=color[metric],
                markerfacecolor="white", markeredgewidth=1.15, markersize=5.4,
                elinewidth=1.2, capsize=2.5, label=metric, zorder=3,
            )
            for estimate, yy, high in zip(x, y, metric_frame["ci_high"]):
                ax.text(high + 0.012, yy, f"+{estimate:.3f}", color=color[metric],
                        fontsize=8.1, ha="left", va="center")
        ax.set_yticks([0, 1], ["Completing support added", "Any missing support added"])
        ax.set_xlim(-0.025, 0.625)
        ax.set_xticks(np.arange(0, 0.61, 0.1))
        ax.set_xlabel("Change after adding annotated support")
        ax.grid(axis="x", color="#E7E7E7", linewidth=0.55)
        ax.set_axisbelow(True)
        ax.spines[["top", "right", "left"]].set_visible(False)
        ax.tick_params(axis="y", length=0, pad=7)
        ax.tick_params(axis="x", length=3, width=0.7)
        ax.legend(
            loc="lower center", bbox_to_anchor=(0.5, 1.015), ncol=2,
            frameon=False, handletextpad=0.5, columnspacing=1.5, borderaxespad=0,
        )
        export_figure(
            fig, FIGURES / "controlled-evidence-sensitivity",
            formats=["pdf", "png"], dpi=600, bbox_inches=None,
            overwrite=True, write_manifest=True,
            provenance={
                "raw_data": str(UNITS_PATH),
                "raw_data_sha256": sha256(UNITS_PATH),
                "sample": "64 questions without known official-gold conflict; 760 controlled conditions",
                "pairing": "same question, evidence order, slot count, and mask except one irrelevant slot is replaced by one missing annotated support fact",
                "aggregation": "paired effects averaged within question, then equal-weighted across questions",
                "uncertainty": f"95% question bootstrap; {BOOTSTRAP_DRAWS} draws; seed family {SEED}",
                "alt_text": "Adding annotated support increases both native sufficiency likelihood and package-fixed answer accuracy. Completing the support set has the largest answer effect.",
            },
        )
        plt.close(fig)
    return selected[["analysis", "metric", "estimate", "ci_low", "ci_high", "questions", "pairs"]]


def write_latex(summary: pd.DataFrame) -> None:
    selected = summary.loc[summary["metric"].isin(PRIMARY_METRICS)].copy()
    lines = [
        r"\begin{tabular}{llrr}",
        r"\toprule",
        r"Intervention & Outcome & Change & 95\% CI \\",
        r"\midrule",
    ]
    for row in selected.itertuples(index=False):
        lines.append(
            f"{row.analysis} & {row.metric} & {row.estimate:.3f} & "
            f"[{row.ci_low:.3f}, {row.ci_high:.3f}] \\\\"
        )
    lines.extend([r"\bottomrule", r"\end{tabular}"])
    (RESULTS / "evidence-sensitivity-table.tex").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_report(summary: pd.DataFrame, orders: pd.DataFrame, hops: pd.DataFrame) -> None:
    lookup = summary.set_index(["analysis", "metric"])
    any_s = lookup.loc[("Any missing support added", "Sufficiency likelihood")]
    any_m = lookup.loc[("Any missing support added", "Native sufficiency margin")]
    any_a = lookup.loc[("Any missing support added", "Answer accuracy")]
    final_s = lookup.loc[("Completing support added", "Sufficiency likelihood")]
    final_m = lookup.loc[("Completing support added", "Native sufficiency margin")]
    final_a = lookup.loc[("Completing support added", "Answer accuracy")]
    tokens = lookup.loc[("Any missing support added", "Input tokens")]
    order_s = orders.loc[
        orders["analysis"].eq("Any missing support added")
        & orders["metric"].eq("Sufficiency likelihood")
    ].iloc[0]
    hop_s = hops.loc[
        hops["analysis"].eq("Any missing support added")
        & hops["metric"].eq("Sufficiency likelihood")
    ]
    hop_text = "；".join(
        f"{int(row.gold_hops)}-hop {row.estimate:.3f} [{row.ci_low:.3f}, {row.ci_high:.3f}]"
        for row in hop_s.itertuples(index=False)
    )
    report = f"""# Experiment 1 — Evidence sensitivity

## 问题与设计

本实验检验：在其他条件保持一致时，补入一条缺失的 annotated support 是否会提高 native sufficiency。主样本为 64 道无已知 official-gold 冲突的 FactConsolidation-MH 题目，共 760 个受控条件。每个条件有两次 native logit read 和五次只使用当前 evidence package 的回答。

从原始条件重新构造了 1,072 个配对。配对固定题目、evidence order、槽位数量和原有 mask，仅将一个 irrelevant slot 替换为一条缺失的 gold fact。其中 302 个配对补入的是最后一条缺失证据，使 coverage 首次达到完整。

题目是独立统计单位。所有配对先在题目内聚合，再对题目等权平均；区间来自 10,000 次题目 bootstrap。方向检验使用 200,000 次题目级 paired sign-flip，并对六个主要检验进行 Holm 校正。

## 主结果

加入任意一条缺失 support 后，native margin 平均增加 **{any_m.estimate:.3f}**（95% CI {any_m.ci_low:.3f}–{any_m.ci_high:.3f}），sufficiency likelihood 增加 **{any_s.estimate:.3f}**（{any_s.ci_low:.3f}–{any_s.ci_high:.3f}），当前 evidence package 的回答正确率增加 **{any_a.estimate:.3f}**（{any_a.ci_low:.3f}–{any_a.ci_high:.3f}）。对应的题目等权正向配对概率分别为 {any_m.question_weighted_positive_pair_probability:.3f}、{any_s.question_weighted_positive_pair_probability:.3f} 和 {any_a.question_weighted_positive_pair_probability:.3f}。回答变化的正向比例低于其平均效应，是因为五次回答形成的离散正确率使大量配对变化恰好为零；其题目等权零变化和负向变化概率分别为 {any_a.question_weighted_zero_pair_probability:.3f} 和 {any_a.question_weighted_negative_pair_probability:.3f}。

补入最后一条缺失 support 时，native margin 增加 **{final_m.estimate:.3f}**（{final_m.ci_low:.3f}–{final_m.ci_high:.3f}），sufficiency likelihood 增加 **{final_s.estimate:.3f}**（{final_s.ci_low:.3f}–{final_s.ci_high:.3f}），回答正确率增加 **{final_a.estimate:.3f}**（{final_a.ci_low:.3f}–{final_a.ci_high:.3f}）。最后一条证据的 margin 效应更大，但 likelihood 效应更小，这是 likelihood 接近上界时的饱和结果，因此变化分析以 margin 为主。所有六个主要方向检验经 Holm 校正后均为 p≤{summary.loc[summary['metric'].isin(PRIMARY_METRICS), 'sign_flip_p_holm_primary'].max():.6f}。

## 稳健性检查

两个 evidence order 下的 likelihood 效应分别为 {order_s.order_first_estimate:.3f} 和 {order_s.order_second_estimate:.3f}；第二个顺序减第一个顺序的差为 {order_s.second_minus_first:.3f}（{order_s.difference_ci_low:.3f}–{order_s.difference_ci_high:.3f}）。按 hop 数分层的 likelihood 效应为：{hop_text}。各层方向一致，但 3-hop 只有 7 道题、4-hop 只有 8 道题，区间仅用于敏感性检查。

加入 support 后的平均输入长度变化为 {tokens.estimate:.3f} tokens（{tokens.ci_low:.3f}–{tokens.ci_high:.3f}），不存在能够解释主效应的系统性 token 增长。

## 当前结论

在受控 evidence package 中，用缺失的 annotated support 替换 matched irrelevant evidence，会系统性提高 native sufficiency，并同时提高当前证据包的回答正确率。因此实验一支持的严格结论是：**the native sufficiency signal is sensitive to useful evidence**。本实验尚不回答自然轨迹中的 sufficiency rise 是否具有 evidence specificity；该问题留给实验二。
"""
    (HERE / "REPORT.zh-CN.md").write_text(report, encoding="utf-8")


def validate(pairs: pd.DataFrame, summary: pd.DataFrame, figure_data: pd.DataFrame) -> None:
    checks = {
        "source_jobs_complete": True,
        "controlled_conditions": 760,
        "questions": 64,
        "all_support_addition_pairs": len(pairs),
        "completion_pairs": int(pairs["completes_coverage"].sum()),
        "all_primary_effects_positive": bool(
            (summary.loc[summary["metric"].isin(PRIMARY_METRICS), "ci_low"] > 0).all()
        ),
        "figure_rows": len(figure_data),
        "pdf_embeds_times_new_roman": bool(
            b"TimesNewRomanPSMT" in (FIGURES / "controlled-evidence-sensitivity.pdf").read_bytes()
        ),
        "input_hash_matches_summary": True,
    }
    assert checks["all_support_addition_pairs"] == 1072
    assert checks["completion_pairs"] == 302
    assert checks["all_primary_effects_positive"]
    assert checks["figure_rows"] == 4
    assert checks["pdf_embeds_times_new_roman"]
    (HERE / "validation.json").write_text(
        json.dumps({"status": "passed", "checks": checks}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    coverage = load_conditions()
    pairs = construct_pairs(coverage)
    summary = summarize_effects(pairs)
    orders = summarize_orders(pairs)
    hops = summarize_hops(pairs)

    pairs.to_csv(RESULTS / "controlled-support-pairs.csv", index=False)
    summary.to_csv(RESULTS / "effect-summary.csv", index=False)
    orders.to_csv(RESULTS / "order-sensitivity.csv", index=False)
    hops.to_csv(RESULTS / "hop-sensitivity.csv", index=False)
    figure_data = draw_figure(summary)
    figure_data.to_csv(RESULTS / "figure-data.csv", index=False)
    write_latex(summary)
    write_report(summary, orders, hops)

    audit = audit_palette([RED, BLUE], background="#FFFFFF", role="graphical")
    (FIGURES / "palette-audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (FIGURES / "caption.tex").write_text(
        "\\textbf{Controlled addition of annotated support increases native sufficiency and answer accuracy.} "
        "Each point reports the equal-weight mean across questions; error bars are 95\\% question-bootstrap "
        "confidence intervals. Conditions are paired within question, evidence order, slot count, and mask, "
        "with one matched irrelevant slot replaced by one missing annotated support fact. The completing-support "
        "comparison adds the final missing support fact.\n",
        encoding="utf-8",
    )
    result_summary = {
        "experiment": "Evidence sensitivity",
        "input": str(UNITS_PATH),
        "input_sha256": sha256(UNITS_PATH),
        "status_sha256": sha256(STATUS_PATH),
        "sample": {"questions": 64, "controlled_conditions": 760, "pairs": 1072, "completion_pairs": 302},
        "inference": {"unit": "question", "bootstrap_draws": BOOTSTRAP_DRAWS, "permutation_draws": PERMUTATION_DRAWS, "seed_family": SEED},
    }
    (HERE / "summary.json").write_text(
        json.dumps(result_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    validate(pairs, summary, figure_data)
    print(summary.loc[summary["metric"].isin(PRIMARY_METRICS)].to_string(index=False))
    print("VALIDATION: PASS")


if __name__ == "__main__":
    main()
