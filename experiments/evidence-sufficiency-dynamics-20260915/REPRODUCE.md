# Reproduction

This directory contains the frozen offline analysis for the Picorer evidence–sufficiency dynamics study.

Run from the workspace root:

```bash
experiments/sufficiency-dynamics-20260912/.venv-figures/bin/python \
  experiments/evidence-sufficiency-dynamics-20260915/analyze.py

experiments/sufficiency-dynamics-20260912/.venv-figures/bin/python \
  experiments/evidence-sufficiency-dynamics-20260915/validate.py
```

The analysis consumes completed inference outputs only. Source paths and SHA-256 hashes are recorded in `summary.json`; the validator checks them before accepting the derived artifacts.

Statistical inference treats the question as the independent unit. All confidence intervals use 5,000 question-cluster bootstrap draws with seed family 20260915. The primary sample contains 64 questions without known official-gold conflicts; the 100-question result is retained as a sensitivity analysis.

The main figure aligns natural trajectories to their first observed state with complete annotated evidence coverage. It uses integer decision offsets, does not pad incomplete trajectories, and applies no smoothing or monotonicity constraint.
