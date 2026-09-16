# Reproduce Experiment 1

Run from the workspace root:

```bash
experiments/sufficiency-dynamics-20260912/.venv-figures/bin/python \
  experiments/evidence-sufficiency-dynamics-20260915/experiment-1-evidence-sensitivity/analyze.py
```

The script reconstructs controlled support-addition pairs directly from the completed inference-unit table, computes all question-level statistics, exports the figure and tables, and writes `validation.json`.

Figure-export and integrity checks follow: Kassis, T., Agarwal, V., He, Y., Patel, D., and Brueckner, A. M. (2026), “Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents,” arXiv:2609.00065, https://doi.org/10.48550/arXiv.2609.00065.
