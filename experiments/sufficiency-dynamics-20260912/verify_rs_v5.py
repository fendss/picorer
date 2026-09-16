#!/usr/bin/env python3
"""Independent source/estimator checks; no model calls and no raw-data writes."""
import hashlib
import json
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.special import expit
from scipy.stats import rankdata

import redraw_rs_v5 as m
from image_metadata import inspect_raster, inspect_pdf


def main():
    d = pd.read_csv(m.OUT / "states-with-sigmoid.csv")
    keys = ["round", "question_id", "decision_step"]
    paths = ["run1", "run2", "complete-run"]
    raw = pd.concat([pd.read_csv(m.ROOT / f"coverage/{path}/state-replica.csv").assign(round=f"Run {i}")
        for i, path in enumerate(paths, 1)], ignore_index=True)
    assert len(raw) == 4300 and raw.groupby(keys).size().eq(2).all()
    collapsed = raw.groupby(keys).agg(s=("native_logit_margin", "mean"), r=("gold_coverage_r", "first"),
        correctness=("final_correct", "first")).reset_index()
    both = d.merge(collapsed, on=keys, validate="one_to_one")
    assert len(both) == 2150
    assert np.allclose(both.native_s, both.s, atol=1e-12)
    assert np.allclose(both.committed_r, both.r, atol=1e-12)
    assert np.array_equal(both.correct, both.correctness)
    assert np.allclose(d.p, expit(d.native_s), atol=1e-15)
    assert np.array_equal(rankdata(d.p), rankdata(d.native_s))
    # A different implementation: fit the full dummy-variable model directly.
    dummy = pd.get_dummies(d.run_question, dtype=float).to_numpy()
    x = np.column_stack([d.committed_r, d.tau, dummy])
    w = 1/d.groupby("run_question").decision_step.transform("size").to_numpy()
    coef_checks = []
    saved = pd.read_csv(m.OUT / "within-trajectory-regression.csv")
    for metric in ["native_s", "p"]:
        fit = sm.WLS(d[metric], x, weights=w).fit()
        row = saved[(saved["sample"] == "all") & saved.outcome.eq(metric) & saved.term.eq("committed_r") & saved.controls.eq("committed_r+tau")].iloc[0]
        assert np.isclose(fit.params.iloc[0], row.estimate, atol=1e-10)
        coef_checks.append(dict(score=metric, direct_dummy_coefficient=fit.params.iloc[0], demeaned_coefficient=row.estimate))
    aligned = pd.read_csv(m.OUT / "temporal-aligned-means.csv")
    assert aligned.questions.eq(100).all() and aligned.trajectories.eq(300).all()
    terminal = d[d.terminal].copy()
    auc = {}
    for metric in ["native_s", "p", "committed_r"]:
        n1 = terminal.correct.sum()
        ranks = rankdata(terminal[metric])
        auc[metric] = float((ranks[terminal.correct].sum()-n1*(n1+1)/2)/(n1*(len(terminal)-n1)))
    assert auc["native_s"] == auc["p"]
    c = m.bootstrap_counts(100)
    questions = sorted(d.question_id.unique())
    cells = []
    for full in [False, True]:
        for positive in [False, True]:
            g = terminal[terminal.full_committed.eq(full) & terminal.native_positive.eq(positive)]
            sums = g.groupby("question_id").correct.sum().reindex(questions, fill_value=0).to_numpy()
            ns = g.groupby("question_id").size().reindex(questions, fill_value=0).to_numpy()
            den = c @ ns
            draws = np.divide(c@sums, den, out=np.full(len(c), np.nan), where=den>0)
            lo, hi = np.nanpercentile(draws, [2.5, 97.5])
            cells.append(dict(full=full, positive=positive, n=len(g), correct=int(g.correct.sum()),
                accuracy=g.correct.mean(), low=lo, high=hi))
    pd.DataFrame(cells).to_csv(m.OUT / "terminal-observed-cells.csv", index=False)
    metadata = []
    for path in sorted(m.OUT.glob("*.png")):
        meta = inspect_raster(path, max_pixels=100_000_000)
        assert meta["width_px"] == 2880 and meta["dpi_x"] > 449
        metadata.append(dict(file=path.name, **meta))
    for path in sorted(m.OUT.glob("*.pdf")):
        meta = inspect_pdf(path)
        metadata.append(dict(file=path.name, **meta))
    report = dict(status="passed", checks=["4300 raw replicas collapse exactly to 2150 analyzed states",
        "S, R and correctness agree with raw source tables", "sigmoid and binary/rank invariance",
        "full dummy-variable WLS agrees with within-transformation estimator",
        "aligned means retain all 100 questions and 300 trajectories", "450 dpi export metadata"],
        regressions=coef_checks, terminal_auc=auc, cells=cells, export_metadata=metadata,
        source_sha256=hashlib.sha256(m.SOURCE.read_bytes()).hexdigest())
    m.write_json("validation.json", report)
    print(json.dumps({k:v for k,v in report.items() if k != "export_metadata"}, indent=2, default=float))


if __name__ == "__main__":
    main()
