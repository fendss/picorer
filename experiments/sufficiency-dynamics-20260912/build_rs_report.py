#!/usr/bin/env python3
"""Rebuild the R/S report from audited per-state evidence and frozen scores.

Preview input must be extracted by the section-isolated extractor (2026-09-14).
No model inference is performed. Gold-aware selection is explicitly an oracle
diagnostic, not a deployable stop rule. Existing exploratory artifacts remain.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib as mpl

import analyze_sufficiency_failure_modes as source
import analyze_sufficiency_ten_pass as plotting

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'analysis-rs-v4'


def main():
    OUT.mkdir(exist_ok=True)
    plotting.configure_style()
    rng = np.random.default_rng(20260914)
    states = source.load_states(ROOT, OUT / 'visible-context-coverage.csv')
    states = states.drop(columns=['explicit_j', 'explicit_positive']).sort_values(
        ['run_question', 'decision_step']).reset_index(drop=True)
    grouped = states.groupby('run_question')
    for col in ['native_s', 'committed_r', 'current_preview_coverage',
                'ever_seen_or_committed_coverage']:
        states['prev_' + col] = grouped[col].shift()
        states['delta_' + col] = grouped[col].diff()
    states['full_committed'] = states.committed_r >= 1 - 1e-12
    states['current_preview_any'] = states.current_preview_coverage > 1e-12
    states['prev_native_positive'] = states.prev_native_s > 0
    states['reversal'] = states.prev_native_positive & ~states.native_positive
    states.to_csv(OUT / 'states.csv', index=False)
    trajectories = source.trajectory_summary(states)
    trajectories.to_csv(OUT / 'trajectories.csv', index=False)
    terminal = states[states.terminal].copy()
    raw = pd.concat([pd.read_csv(ROOT / rel).assign(round=run)
                     for run, rel in source.INPUTS.items()], ignore_index=True)
    piv = raw.pivot(index=['round', 'question_id', 'decision_step'],
                    columns='replica', values='native_logit_margin')
    result = {'sample': {'questions': 100, 'trajectories': 300, 'states': 2150},
              'reliability': {
                  'correlation': float(piv.corr().iloc[0, 1]),
                  'binary_disagreements': int(((piv.iloc[:, 0] > 0) !=
                                              (piv.iloc[:, 1] > 0)).sum())}}
    summary = pd.read_csv(ROOT / 'analysis-rs-v2/three-rounds/coverage-summary.csv')
    fig, ax = plt.subplots(figsize=(4.7, 2.9))
    ax.errorbar(summary.r, summary.margin_mean,
                yerr=np.vstack([summary.margin_mean-summary.margin_ci_low,
                                summary.margin_ci_high-summary.margin_mean]),
                fmt='o', color=plotting.CMU_RED, capsize=3, markersize=5)
    ax.axhline(0, color=plotting.MID_GRAY, lw=.8, ls='--')
    ax.set(xlabel='当前证据包的标准证据覆盖率 R', ylabel='平均充分性分数 S',
           xlim=(-.04, 1.04))
    ax.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    plotting.tidy(ax)
    plotting.save_figure(fig, OUT, '01-s-by-package-coverage')

    events = plotting.make_event_table(states)
    events.to_csv(OUT / 'event-times.csv', index=False)
    fig, ax = plt.subplots(figsize=(4.8, 3))
    for col, label, color in [
        ('first_s_positive_tau', 'S 首次大于 0', plotting.CMU_RED),
        ('first_committed_any_tau', '包内首次含标准证据', plotting.TEAL),
        ('first_committed_full_tau', '包内标准证据完整', plotting.CHARCOAL)]:
        x = np.r_[0, np.sort(events[col].dropna().unique()), 1]
        y = np.array([(events[col] <= v).mean() for v in x])
        ax.step(x, y, where='post', label=label, color=color, lw=1.6)
    ax.set(xlabel='归一化轨迹进度', ylabel='事件已发生的轨迹比例',
           xlim=(0, 1.02), ylim=(0, 1.02))
    ax.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    ax.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    ax.legend(frameon=False, loc='upper left', fontsize=7.4)
    plotting.tidy(ax)
    plotting.save_figure(fig, OUT, '02-s-and-package-timing')

    pos = trajectories[trajectories.ever_positive]
    result['first_positive'] = {
        'ever_positive': len(pos),
        'r_zero': int((pos.first_positive_committed_r == 0).sum()),
        'current_preview_gold': int(pos.first_positive_has_current_gold_preview.sum()),
        'historical_union_classes': trajectories.visible_class_at_first_positive.value_counts().to_dict(),
        'nonterminal_s_positive': int(states.loc[~states.terminal, 'native_positive'].sum()),
        'nonterminal_states': int((~states.terminal).sum()),
        'trajectories_with_reversals': int((trajectories.sign_reversals > 0).sum())}
    result['evidence_changes'] = plotting.pass_05_evidence_gain(states, OUT, rng, 5000)

    risk = states[states.prev_native_positive & ~states.full_committed].copy()
    cells, _ = plotting.grouped_rate_draws(risk, ['current_preview_any'], 'reversal', rng, 5000)
    cells.to_csv(OUT / 'preview-reversal.csv', index=False)
    result['preview_reversal_incomplete_r'] = cells.to_dict('records')
    fig, ax = plt.subplots(figsize=(4.2, 2.7))
    for i, row in cells.iterrows():
        ax.errorbar(i, row.rate, yerr=[[row.rate-row.ci_low], [row.ci_high-row.rate]],
                    fmt='o', color=plotting.CMU_RED if not row.current_preview_any else plotting.TEAL,
                    capsize=3, markersize=5)
    ax.set(xticks=[0, 1], xticklabels=['当前预览未匹配标准证据', '当前预览含标准证据'],
           ylabel='下一状态 S 变为非正的比例', xlim=(-.4, 1.4), ylim=(0, .26))
    # The predictor and outcome are both measured at the next observation.
    ax.set_ylabel('S 从上一状态正值变为非正的比例')
    ax.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    plotting.tidy(ax)
    plotting.save_figure(fig, OUT, '04-preview-and-s-reversal')

    result['terminal'] = plotting.pass_08_terminal_gate(states, OUT, rng, 5000)
    # Contrasts must report observed differences, not bootstrap means.
    inc = 5/98 - 1/29
    full = 124/163 - 3/10
    for key, value in [('s_effect_when_incomplete', inc), ('s_effect_when_full', full),
                       ('interaction', full-inc)]:
        result['terminal']['contrasts'][key]['estimate'] = value
    result['same_question'] = plotting.pass_09_within_question(states, OUT, rng, 5000)

    terminal['full_gate'] = terminal.full_committed.astype(int)
    methods = {'只按 S 排序': ['native_s'],
               '只按标准证据覆盖率 R 排序': ['committed_r'],
               '优先 R 完整，再按 S 排序': ['full_gate', 'native_s']}
    rows = []
    fig, ax = plt.subplots(figsize=(5, 3.05))
    for (label, cols), color, ls in zip(methods.items(),
            [plotting.TEAL, plotting.MID_GRAY, plotting.CMU_RED], ['-', '--', '-']):
        fractions = np.linspace(.1, 1, 91)
        accuracy = [plotting.expected_top_k_accuracy(terminal, cols, round(300*f)) for f in fractions]
        rows += [{'method': label, 'retained_fraction': float(f), 'accuracy': float(a)}
                 for f, a in zip(fractions, accuracy)]
        ax.plot(fractions, accuracy, label=label, color=color, ls=ls, lw=1.6)
    ax.set(xlabel='保留答案的比例', ylabel='保留答案的正确率', xlim=(.1,1), ylim=(.35,1))
    ax.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    ax.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1))
    ax.legend(frameon=False, loc='upper right', fontsize=7.2)
    plotting.tidy(ax)
    plotting.save_figure(fig, OUT, '07-oracle-ranking')
    pd.DataFrame(rows).to_csv(OUT / 'oracle-ranking.csv', index=False)
    result['selection_at_25_percent'] = {
        label: plotting.expected_top_k_accuracy(terminal, cols, 75)
        for label, cols in methods.items()}
    result['limitations'] = [
        'R uses gold annotations and cannot be deployed as an observable stop criterion.',
        'Preview matches are section-isolated exact text matches, not semantic coverage.',
        'Package contents, current displayed passages, and final answer prompt need not be identical.',
        'No intermediate-state answers or controlled evidence interventions were collected.',
        'All associations are exploratory; resampling preserves question-level dependence.']
    (OUT / 'report-statistics.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=plotting.json_number), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, default=plotting.json_number))


if __name__ == '__main__':
    main()
