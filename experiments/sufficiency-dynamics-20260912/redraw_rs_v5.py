#!/usr/bin/env python3
"""Offline, question-clustered analysis and focused scientific figures.

Run with .venv-figures/bin/python redraw_rs_v5.py. No inference or network I/O.
Source: audited v4 states. A plotting skill is an explicit local dependency.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import numpy as np
import pandas as pd
import seaborn as sns
import statsmodels.api as sm
from scipy.special import expit
from scipy.stats import rankdata

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "analysis-rs-v5"
SOURCE = ROOT / "analysis-rs-v4/states.csv"
SKILL = Path.home() / ".codex/skills/scientific-visualization"
sys.path.insert(0, str(SKILL / "scripts"))
from style_presets import style_context
from figure_export import export_figure
from palette_audit import audit_palette

SEED = 20260914
DRAWS = 5000
RED, BLUE, GRAY = "#B21F32", "#245C7C", "#626262"
COLORS = [RED, BLUE, GRAY]
STYLE = {
    "font.family": "serif",
    "font.serif": ["Times New Roman"],
    "axes.unicode_minus": True,
    "font.size": 10, "axes.labelsize": 10.5, "xtick.labelsize": 9.5,
    "ytick.labelsize": 9.5, "legend.fontsize": 10,
    "axes.labelpad": 7, "axes.edgecolor": "#555555", "axes.linewidth": .65,
    "text.color": "#262626", "axes.labelcolor": "#262626",
    "xtick.color": "#555555", "ytick.color": "#555555",
    "grid.color": "#E8E8E8", "grid.linewidth": .5,
    "figure.constrained_layout.w_pad": .12,
    "figure.constrained_layout.h_pad": .12,
}


def write_json(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2,
        default=lambda v: v.item() if isinstance(v, np.generic) else str(v)), encoding="utf-8")


def bootstrap_counts(n, draws=DRAWS):
    return np.random.default_rng(SEED).multinomial(n, np.full(n, 1/n), size=draws)


def mean_interval(values):
    a = np.asarray(values, dtype=float)
    finite = np.isfinite(a)
    if a.ndim == 1:
        a, finite = a[:, None], finite[:, None]
    weights = bootstrap_counts(len(a))
    den = weights @ finite.astype(float)
    num = weights @ np.nan_to_num(a)
    draws = np.divide(num, den, out=np.full_like(num, np.nan), where=den > 0)
    return np.nanmean(a, axis=0), *np.nanpercentile(draws, [2.5, 97.5], axis=0)


def correlation(x, y, w=None):
    if w is None:
        return float(np.corrcoef(x, y)[0, 1])
    x, y = np.asarray(x), np.asarray(y)
    x = x - np.average(x, weights=w)
    y = y - np.average(y, weights=w)
    return np.sum(w*x*y) / np.sqrt(np.sum(w*x*x)*np.sum(w*y*y))


def correlations(d):
    """Resample whole question clusters and recompute ranks (including ties)."""
    groups = list(d.groupby("question_id", sort=True).indices.values())
    rng = np.random.default_rng(SEED)
    x = d.committed_r.to_numpy()
    ys = [d.native_s.to_numpy(), d.p.to_numpy()]
    centered_x = x - d.groupby("run_question").committed_r.transform("mean")
    centered_y = [d[c] - d.groupby("run_question")[c].transform("mean") for c in ["native_s", "p"]]
    weights = 1 / d.groupby("run_question").decision_step.transform("size").to_numpy()
    rows = []
    samples = np.empty((DRAWS, 2, 3))
    for b in range(DRAWS):
        idx = np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        for j, y in enumerate(ys):
            samples[b, j] = [correlation(x[idx], y[idx]),
                correlation(rankdata(x[idx]), rankdata(y[idx])),
                correlation(centered_x.to_numpy()[idx], centered_y[j].to_numpy()[idx], weights[idx])]
    for j, name in enumerate(["S", "sigmoid(S)"]):
        estimates = [correlation(x, ys[j]), correlation(rankdata(x), rankdata(ys[j])),
            correlation(centered_x, centered_y[j], weights)]
        for k, metric in enumerate(["pooled_pearson", "pooled_spearman", "within_trajectory_weighted_pearson"]):
            low, high = np.percentile(samples[:, j, k], [2.5, 97.5])
            rows.append(dict(outcome=name, metric=metric, estimate=estimates[k], low=low, high=high))
    result = pd.DataFrame(rows)
    result.to_csv(OUT / "correlations.csv", index=False)
    assert np.array_equal(rankdata(ys[0]), rankdata(ys[1]))
    return result


def fe_regression(d, outcome, predictors, sample):
    """Trajectory FE; inverse-length weights; whole-question bootstrap.

    Cluster sufficient statistics allow exact case-resampling WLS refits.
    Every fit is cross-checked against Statsmodels WLS on demeaned data.
    """
    columns = predictors + [outcome]
    z = d[columns] - d.groupby("run_question")[columns].transform("mean")
    x, y = z[predictors].to_numpy(), z[outcome].to_numpy()
    w = 1/d.groupby("run_question").decision_step.transform("size").to_numpy()
    fit = sm.WLS(y, x, weights=w).fit()
    matrices, vectors = [], []
    for ids in d.groupby("question_id", sort=True).indices.values():
        matrices.append(x[ids].T @ (w[ids, None]*x[ids]))
        vectors.append(x[ids].T @ (w[ids]*y[ids]))
    matrices, vectors = np.array(matrices), np.array(vectors)
    beta = np.linalg.solve(matrices.sum(0), vectors.sum(0))
    assert np.allclose(beta, fit.params, rtol=1e-9, atol=1e-10)
    counts = bootstrap_counts(len(matrices))
    bmat = np.einsum("bq,qij->bij", counts, matrices)
    bvec = counts @ vectors
    boot = np.linalg.solve(bmat, bvec[..., None])[..., 0]
    low, high = np.percentile(boot, [2.5, 97.5], axis=0)
    return [dict(sample=sample, outcome=outcome, controls="+".join(predictors),
        term=p, estimate=beta[i], low=low[i], high=high[i],
        within_r_squared=fit.rsquared, questions=d.question_id.nunique(),
        trajectories=d.run_question.nunique(), states=len(d)) for i, p in enumerate(predictors)]


def coverage_means(d):
    # Preserve discrete annotated coverage. Never interpolate across hop strata.
    cols = ["p", "native_s"]
    within = d.groupby(["question_id", "gold_hop_count", "run_question", "committed_r"])[cols].mean().reset_index()
    q = within.groupby(["question_id", "gold_hop_count", "committed_r"])[cols].mean().reset_index()
    q.to_csv(OUT / "coverage-question-means.csv", index=False)
    rows = []
    for hop in [0, 2, 3, 4]:
        frame = q if hop == 0 else q[q.gold_hop_count.eq(hop)]
        for r, g in frame.groupby("committed_r"):
            for metric in cols:
                mean, low, high = mean_interval(g[metric])
                rows.append(dict(hops=hop, r=r, metric=metric, mean=mean[0], low=low[0], high=high[0], questions=len(g)))
    result = pd.DataFrame(rows)
    result.to_csv(OUT / "coverage-means.csv", index=False)
    return result


def temporal_means(d, aligned=False):
    """LOCF at fixed 0.05 grid. No invented state before the first recorded one.

    Main uses original t/T. Separate sensitivity explicitly aligns first/last
    states with u=(t-1)/(T-1); it is NOT silently substituted for t/T.
    """
    grid = np.linspace(0 if aligned else .05, 1, 21 if aligned else 20)
    rows = []
    for _, g in d.groupby("run_question"):
        time = ((g.decision_step-1)/(g.trajectory_length-1)).to_numpy() if aligned else g.tau.to_numpy()
        for v in grid:
            idx = np.searchsorted(time, v+1e-12, side="right")-1
            if idx < 0:
                continue
            row = g.iloc[idx]
            rows.append(dict(question_id=row.question_id, run_question=row.run_question,
                progress=v, p=row.p, native_s=row.native_s, r=row.committed_r))
    sampled = pd.DataFrame(rows)
    q = sampled.groupby(["question_id", "progress"])[["p", "native_s", "r"]].mean().reset_index()
    name = "aligned" if aligned else "original"
    sampled.to_csv(OUT / f"temporal-{name}-trajectory-values.csv", index=False)
    q.to_csv(OUT / f"temporal-{name}-question-values.csv", index=False)
    rows = []
    for metric in ["p", "native_s", "r"]:
        wide = q.pivot(index="question_id", columns="progress", values=metric).reindex(columns=grid)
        mean, low, high = mean_interval(wide.to_numpy())
        for j, v in enumerate(grid):
            rows.append(dict(metric=metric, progress=v, mean=mean[j], low=low[j], high=high[j],
                questions=wide[v].notna().sum(), trajectories=sampled[sampled.progress.eq(v)].run_question.nunique()))
    result = pd.DataFrame(rows)
    result.to_csv(OUT / f"temporal-{name}-means.csv", index=False)
    return result


def terminal_analysis(d):
    t = d[d.terminal].copy().reset_index(drop=True)
    t["full"] = np.isclose(t.committed_r, 1).astype(float)
    t["round2"] = t["round"].eq("Run 2").astype(float)
    t["round3"] = t["round"].eq("Run 3").astype(float)
    rows = []
    predictions = []
    for metric in ["p", "native_s"]:
        columns = ["intercept", metric, "full", "interaction", "round2", "round3"]
        x = np.column_stack([np.ones(len(t)), t[metric], t.full, t[metric]*t.full, t.round2, t.round3])
        fit = sm.GLM(t.correct.astype(float), x, family=sm.families.Binomial()).fit(
            cov_type="cluster", cov_kwds={"groups": t.question_id, "use_correction": True})
        assert fit.converged
        ci = fit.conf_int()
        for j, col in enumerate(columns):
            rows.append(dict(outcome="correct", score=metric, term=col, coefficient=fit.params.iloc[j],
                low=ci.iloc[j, 0], high=ci.iloc[j, 1], p_value=fit.pvalues.iloc[j],
                interval="question-cluster sandwich, normal Wald", converged=fit.converged))
        for full in [0, 1]:
            support = t.loc[t.full.eq(full), metric]
            for p in np.linspace(support.min(), support.max(), 151):
                xp = np.array([[1, p, full, p*full, 0, 0], [1, p, full, p*full, 1, 0], [1, p, full, p*full, 0, 1]])
                probs = expit(xp @ fit.params)
                mu = probs.mean()
                grad = ((probs*(1-probs))[:, None]*xp).mean(0)
                # Delta-method interval on the logit of the round-averaged probability.
                se = np.sqrt(grad @ fit.cov_params() @ grad)/(mu*(1-mu))
                lo, hi = expit(np.log(mu/(1-mu)) + np.array([-1, 1])*1.95996398454*se)
                predictions.append(dict(score=metric, full=full, x=p, mean=mu, low=lo, high=hi))
            contrast = np.array([0, 1, 0, full, 0, 0])
            effect = float(contrast @ fit.params)
            test = fit.t_test(contrast)
            bounds = np.asarray(test.conf_int()).ravel()
            rows.append(dict(outcome="correct", score=metric, term=f"slope_when_full_{full}",
                coefficient=effect, low=bounds[0], high=bounds[1], p_value=float(np.asarray(test.pvalue).item()),
                interval="question-cluster sandwich, normal Wald", converged=fit.converged))
    pd.DataFrame(rows).to_csv(OUT / "terminal-logistic-regression.csv", index=False)
    pred = pd.DataFrame(predictions)
    pred.to_csv(OUT / "terminal-regression-curves.csv", index=False)
    # Raw observations stay available; quartiles used only as a graphical check.
    empirical = []
    for metric in ["p", "native_s"]:
        for full, g in t.groupby("full"):
            for quartile, cell in g.groupby(pd.qcut(g[metric], q=4, duplicates="drop"), observed=True):
                empirical.append(dict(score=metric, full=full, x=cell[metric].mean(), accuracy=cell.correct.mean(),
                    n=len(cell), correct=cell.correct.sum(), x_min=cell[metric].min(), x_max=cell[metric].max()))
    empirical = pd.DataFrame(empirical)
    empirical.to_csv(OUT / "terminal-empirical-quartiles.csv", index=False)
    t.to_csv(OUT / "terminal-states.csv", index=False)
    return pred, empirical, pd.DataFrame(rows)


def setup_axes(ylabel, probability=True):
    fig, ax = plt.subplots(figsize=(6.4, 3.85), layout="constrained")
    ax.set_ylabel(ylabel)
    ax.grid(axis="y")
    sns.despine(ax=ax)
    ax.tick_params(length=3, pad=5)
    if probability:
        ax.set_ylim(-.025, 1.035)
        ax.set_yticks([0, .25, .5, .75, 1], ["0", "0.25", "0.50", "0.75", "1"])
    return fig, ax


def save(fig, stem, sources, transformations, alt):
    export_figure(fig, OUT / stem, formats=["pdf", "png"], dpi=450, bbox_inches=None,
        overwrite=True, write_manifest=True, provenance={
            "input": str(SOURCE), "input_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "source_tables": sources, "transformations": transformations,
            "uncertainty": "95% pointwise question-cluster bootstrap, 5000 draws; terminal GLM uses clustered sandwich delta method",
            "seed": SEED, "alt_text": alt, "destination": "General research report, 162.56 mm width; journal requirements not specified"})
    plt.close(fig)


def series_legend(ax, series):
    """Consistent top-centered legend, without error-bar or band clutter."""
    handles = [Line2D([], [], color=color, linestyle=ls, marker=marker,
        markersize=4, markerfacecolor="white", markeredgewidth=.9,
        linewidth=1.5, label=label) for label, color, ls, marker in series]
    ax.legend(handles=handles, loc="lower center", bbox_to_anchor=(.5, 1.025),
        ncol=len(handles), frameon=False, handlelength=2.6, handletextpad=.65,
        columnspacing=2.2, borderaxespad=0, labelspacing=.35)


def draw_temporal(table, aligned=False, raw=False):
    fig, ax = setup_axes("Mean logit margin, S" if raw else "Mean", not raw)
    metrics = ["native_s"] if raw else ["p", "r"]
    series = [("Sufficiency likelihood", RED, "-", "o"), ("Evidence coverage", BLUE, "--", "s")]
    for metric, (label, color, ls, marker) in zip(metrics, series):
        g = table[table.metric.eq(metric)]
        sns.lineplot(data=g, x="progress", y="mean", estimator=None, errorbar=None,
            color=color, linestyle=ls, linewidth=1.6, ax=ax)
        ax.fill_between(g.progress, g.low, g.high, color=color, alpha=.12, linewidth=0)
        ax.plot(g.progress.iloc[::2], g["mean"].iloc[::2], marker=marker, ls="none", color=color,
            ms=3.5, markerfacecolor="white", markeredgewidth=.9, clip_on=False)
    if not raw:
        series_legend(ax, series)
    if raw:
        ax.axhline(0, color=GRAY, ls=":", lw=.8)
    if not aligned:
        ax.axvspan(0, 1/3, color="#F4F4F4", zorder=-2)
    ax.set(xlim=(0, 1), xlabel="Endpoint-aligned acquisition progress" if aligned else "Normalized acquisition progress (t/T)")
    ax.set_xticks([0, .25, .5, .75, 1], ["0", "0.25", "0.50", "0.75", "1"])
    stem = "S1-aligned-mean-trajectories" if aligned else ("S2-raw-margin-trajectory" if raw else "01-mean-trajectories")
    save(fig, stem, [f"temporal-{'aligned' if aligned else 'original'}-means.csv"],
        ["sigmoid per state before averaging", "LOCF on 0.05 grid; no extrapolation before first state",
         "average available runs per question, then questions; grey region: not all trajectories observed"],
        "充分性倾向和包内标准证据覆盖率随检索推进上升；两条曲线不是同一种概率。")


def draw_coverage(table, raw=False):
    fig, ax = setup_axes("Mean logit margin, S" if raw else "Mean sufficiency likelihood", not raw)
    series = []
    for hop, color, marker, ls in zip([2, 3, 4], COLORS, ["o", "s", "^"], ["-", "--", "-."]):
        g = table[table.hops.eq(hop) & table.metric.eq("native_s" if raw else "p")]
        ax.errorbar(g.r, g["mean"], yerr=[g["mean"]-g.low, g.high-g["mean"]], fmt=marker,
            linestyle=ls, color=color, lw=1.5, ms=4.5, markerfacecolor="white", markeredgewidth=1,
            elinewidth=.7, capsize=2, label=f"{hop}-hop")
        series.append((f"{hop}-hop", color, ls, marker))
    ax.set(xlabel="Gold-evidence coverage, R", xlim=(-.035, 1.035))
    ax.set_xticks([0, .25, .5, .75, 1], ["0", "0.25", "0.50", "0.75", "1"])
    series_legend(ax, series)
    if raw:
        ax.axhline(0, color=GRAY, ls=":", lw=.8)
    save(fig, "S3-raw-margin-by-coverage" if raw else "02-sufficiency-by-coverage", ["coverage-means.csv"],
        ["same-R states averaged within trajectory, then runs within question, then questions",
         "stratify annotated hop count to avoid mixing different denominators; straight segments are descriptive, not fitted"],
        "按二、三、四跳题分别显示覆盖率与充分性倾向的均值和区间；总体上升但中间覆盖水平并非严格单调。")


def draw_terminal(pred, empirical, raw=True):
    fig, ax = setup_axes("Final-answer accuracy")
    metric = "native_s" if raw else "p"
    pred = pred[pred.score.eq(metric)]
    empirical = empirical[empirical.score.eq(metric)]
    series = []
    for full, color, ls, marker, label in [(1, RED, "-", "o", "Complete evidence (R = 1)"), (0, BLUE, "--", "s", "Incomplete evidence (R < 1)")]:
        g = pred[pred.full.eq(full)]
        ax.plot(g.x, g["mean"], color=color, linestyle=ls, lw=1.6)
        ax.fill_between(g.x, g.low, g.high, color=color, alpha=.12, lw=0)
        e = empirical[empirical.full.eq(full)]
        ax.scatter(e.x, e.accuracy, color=color, marker=marker, s=23,
            facecolors="white", edgecolors=color, linewidths=1, zorder=3)
        series.append((label, color, ls, marker))
    series_legend(ax, series)
    if raw:
        ax.set(xlabel="Terminal logit margin, S", xlim=(pred.x.min()-.3, pred.x.max()+.3))
    else:
        ax.set(xlabel="Terminal sufficiency likelihood", xlim=(-.02, 1.02))
        ax.set_xticks([0, .25, .5, .75, 1], ["0", "0.25", "0.50", "0.75", "1"])
    save(fig, "03-correctness-regression" if raw else "S4-sigmoid-correctness-regression", ["terminal-regression-curves.csv", "terminal-empirical-quartiles.csv"],
        [f"binomial GLM: correctness ~ {metric} + full R + interaction + round fixed effects",
         "curves averaged over three rounds; only observed p range in each R group",
         "hollow points: within-R empirical quartile means; no x jitter; no fitted values used for points"],
        "相同的高充分性倾向下，标准证据包完整与不完整的最终正确率明显不同；曲线为观察性回归而非校准曲线。")


def main():
    OUT.mkdir(exist_ok=True)
    d = pd.read_csv(SOURCE).sort_values(["run_question", "decision_step"]).reset_index(drop=True)
    assert len(d) == 2150 and d.run_question.nunique() == 300 and d.question_id.nunique() == 100
    assert not d.duplicated(["run_question", "decision_step"]).any()
    assert d[["native_s", "committed_r", "tau"]].notna().all().all()
    assert d.groupby("run_question").terminal.sum().eq(1).all()
    assert np.allclose(d.tau, d.decision_step/d.trajectory_length)
    assert (d.groupby("run_question").committed_r.diff().dropna() >= -1e-12).all()
    d["p"] = expit(d.native_s)
    d["tau2"] = d.tau**2
    assert np.array_equal(d.p > .5, d.native_s > 0)
    d.to_csv(OUT / "states-with-sigmoid.csv", index=False)
    print("Validated 2,150 states; computing question-clustered statistics.", flush=True)
    corr = correlations(d)
    regression = []
    for name, frame in [("all", d), ("no_gold_conflict", d[~d.conflicted]), *list(d.groupby("round"))]:
        for outcome in ["native_s", "p"]:
            for predictors in [["committed_r", "tau"], ["committed_r", "tau", "tau2"]]:
                regression += fe_regression(frame.reset_index(drop=True), outcome, predictors, name)
    regression = pd.DataFrame(regression)
    regression.to_csv(OUT / "within-trajectory-regression.csv", index=False)
    coverage = coverage_means(d)
    temporal = temporal_means(d)
    aligned = temporal_means(d, aligned=True)
    pred, empirical, logistic = terminal_analysis(d)
    terminal = d[d.terminal]
    report = dict(questions=100, trajectories=300, states=2150, correct=int(terminal.correct.sum()),
        state_p_above_099=float((d.p > .99).mean()), terminal_p_above_099=int((terminal.p > .99).sum()),
        source_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        invariance=dict(decisions_identical=True, state_ranks_identical=True),
        correlations=corr.to_dict("records"),
        primary_fe=regression[(regression["sample"] == "all") & regression.controls.eq("committed_r+tau")].to_dict("records"),
        terminal_logistic=logistic.to_dict("records"),
        bootstrap=dict(draws=DRAWS, seed=SEED, unit="question; all runs and all states retained"))
    write_json("statistics.json", report)
    write_json("palette-audit.json", audit_palette(COLORS, role="normal-text"))
    versions = {name: importlib.metadata.version(name) for name in ["numpy", "pandas", "scipy", "statsmodels", "matplotlib", "seaborn", "pillow", "pypdf"]}
    write_json("environment.json", {"python": sys.version, "packages": versions,
        "skill": "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/scientific-visualization",
        "skill_sha256": hashlib.sha256((SKILL / "SKILL.md").read_bytes()).hexdigest()})
    print(corr.to_string(index=False), flush=True)
    print(regression[(regression["sample"] == "all")].to_string(index=False), flush=True)
    print(logistic.to_string(index=False), flush=True)
    with style_context("default", palette_name="okabe_ito_on_white"), plt.rc_context(STYLE):
        draw_temporal(temporal)
        draw_coverage(coverage)
        draw_terminal(pred, empirical)
        draw_terminal(pred, empirical, raw=False)
        draw_temporal(aligned, aligned=True)
        draw_temporal(temporal, raw=True)
        draw_coverage(coverage, raw=True)
    print(f"Finished: {OUT}", flush=True)


def render_existing():
    """Presentation-only refresh; preserve every statistical table and result."""
    import re
    from matplotlib.font_manager import findfont
    from pypdf import PdfReader
    from image_metadata import inspect_pdf
    font_path = findfont("Times New Roman", fallback_to_default=False)
    inputs = list(OUT.glob("*.csv")) + [OUT / "statistics.json"]
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    with style_context("default", palette_name="okabe_ito_on_white"), plt.rc_context(STYLE):
        temporal = pd.read_csv(OUT / "temporal-original-means.csv")
        coverage = pd.read_csv(OUT / "coverage-means.csv")
        pred = pd.read_csv(OUT / "terminal-regression-curves.csv")
        empirical = pd.read_csv(OUT / "terminal-empirical-quartiles.csv")
        draw_temporal(temporal)
        draw_coverage(coverage)
        draw_terminal(pred, empirical)
        draw_terminal(pred, empirical, raw=False)
        draw_temporal(pd.read_csv(OUT / "temporal-aligned-means.csv"), aligned=True)
        draw_temporal(temporal, raw=True)
        draw_coverage(coverage, raw=True)
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    assert before == after
    exported = []
    for path in sorted(OUT.glob("*.pdf")):
        text = "\n".join(page.extract_text() for page in PdfReader(path).pages)
        assert not re.search(r"[\u3400-\u9fff]", text), path.name
        assert "sigmoid" not in text.lower(), path.name
        metadata = inspect_pdf(path)
        assert metadata["font_resources"]["all_embedded"], path.name
        assert all("TimesNewRoman" in f["base_font"] for f in metadata["font_resources"]["fonts"]), path.name
        exported.append({"file": path.name, "text": text, "metadata": metadata})
    write_json("presentation-validation.json", {"status": "passed", "figure_language": "English",
        "style": "Times New Roman; top-centered frameless legends; descriptive variable labels",
        "font_path": font_path,
        "statistical_inputs_unchanged": before == after, "input_hashes": before, "figures": exported})
    print(f"Updated {len(exported)} English figures; statistics unchanged; fonts embedded.")


if __name__ == "__main__":
    if sys.argv[1:] == ["--figures-only"]:
        render_existing()
    else:
        main()
