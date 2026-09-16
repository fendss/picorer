# Picorer R–S Dynamics Analysis

This directory contains the question-balanced analysis of gold-evidence
coverage (`R`), native finish sufficiency, and final answer correctness.
The primary sufficiency readout is the native logit margin

```text
m = log p(sufficient) - log p(insufficient)
```

and the induced native decision is `sufficient` exactly when `m > 0`.
Explicit prompted judgments (`J`) are not used as ground truth in this
analysis.

## Statistical unit

1. The two model replicas are averaged within each frozen agent state.
2. States that share a coverage level are averaged within each trajectory.
3. Independent rounds of the same benchmark question are averaged where the
   estimand is a coverage-conditioned population curve.
4. Confidence intervals resample benchmark questions, preserving all rounds
   belonging to each sampled question.
5. The controlled analysis uses trajectory fixed effects and gives every
   trajectory equal total weight, so long trajectories do not dominate.

Intervals are 95% percentile intervals from 5,000 question-cluster bootstrap
draws. The analysis is observational; controlled associations and event-aligned
changes should not be described as causal effects before evidence intervention.

## Figures

- `01-coverage-over-acquisition`: objective evidence recovery over normalized
  acquisition time.
- `02-margin-over-acquisition`: native finish margin over normalized time.
- `03-margin-by-coverage`: question-balanced margin distributions at each
  observed gold-coverage level; open dots and whiskers show the mean and 95% CI.
- `04-native-stop-rate-by-coverage`: fraction of states with a positive native
  margin at each coverage level.
- `05-margin-shift-at-evidence-gain`: per-question change in native margin for
  adjacent states with and without newly acquired gold evidence.
- `06-terminal-state-map`: terminal coverage and margin, separated by final
  answer correctness.
- `07-replication-controlled-effect`: per-round and combined coverage
  coefficients after controlling acquisition time.
- `08-controlled-drivers`: mutually controlled contributions of coverage and
  acquisition time over their unit ranges.
- `09-terminal-correctness-auc`: how well terminal coverage and terminal margin
  discriminate correct from incorrect answers.
- `10-lww-clean-sensitivity`: controlled coverage coefficient with and without
  questions flagged as official-gold/LWW conflicted.

Correct-minus-incorrect contrasts across independent trajectories of the same
question are retained in `analysis-summary.json`; they are not combined in one
figure because coverage differences and logit-margin differences have
incommensurate units.

Every figure is exported as a vector PDF and a 450-dpi PNG. Supporting CSVs and
the complete machine-readable estimates are stored alongside the figures.

## Reproduce

```bash
python3 experiments/sufficiency-dynamics-20260912/analyze_rs_dynamics.py \
  --round 'Run 1=PATH/TO/RUN1/state-replica.csv' \
  --round 'Run 2=PATH/TO/RUN2/state-replica.csv' \
  --round 'Run 3=PATH/TO/RUN3/state-replica.csv' \
  --output-dir experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds \
  --bootstrap-draws 5000
```
