# Picorer v1.0.0 experiment artifacts

This directory contains the structured data, analysis code, reports, and figures for the Qwen3.6-27B evidence--sufficiency experiments run with Picorer v1.0.0.

## Contents

- `fact-mh-rq1-rq2-20260914/`: terminal-trajectory tables, matching audits, provenance, and the RQ1-to-RQ2 transition analysis.
- `full-required-working-memory-20260911/`: the working-memory intervention, frozen source snapshot, patch, launch record, and results.
- `sufficiency-dynamics-20260912/`: three independent 100-question acquisition runs, 2,150 decision states, two native measurements per state, and 101 explicit labels per state and replica.
- `sufficiency-interventions-20260914/`: 10,018 controlled units, 34,126 completed inference jobs represented by local summaries, and 18,390 answer samples.
- `evidence-sufficiency-dynamics-20260915/`: offline derived tables, statistical analyses, validation records, and publication figures.

The complete data layout, field definitions, join keys, execution flow, and server-side raw-artifact boundaries are documented in [`evidence-sufficiency-dynamics-20260915/DATA_AND_EXECUTION_GUIDE.zh-CN.md`](evidence-sufficiency-dynamics-20260915/DATA_AND_EXECUTION_GUIDE.zh-CN.md).

## Release integrity

The released copy preserves question identifiers, measurements, labels, scores, and statistical values. Product identifiers, machine namespaces, deployment paths, report titles, and generated artifacts use the canonical Picorer v1.0.0 namespace.

Virtual environments, interpreter caches, macOS metadata, redundant QA ZIP files, and other regenerable machine-local files are excluded. `ARTIFACT_MANIFEST.json` records the size and SHA-256 digest of every released experiment artifact. `STRUCTURED_DATA_VALIDATION.json` records the numerical data checks.

The 219 MB compressed terminal-request archive is not part of the v1.0.0 release. The verified structured tables are the public experiment dataset.

## Primary tables

- `sufficiency-interventions-20260914/summary/units.csv`: one row per logical state or intervention condition.
- `sufficiency-interventions-20260914/summary/answers.csv`: one row per independent answer generation.
- `sufficiency-dynamics-20260912/coverage/<run>/states.csv`: one row per natural decision state.
- `sufficiency-dynamics-20260912/coverage/<run>/state-replica.csv`: native and explicit measurements split by inference replica.
- `sufficiency-dynamics-20260912/coverage/<run>/hops.csv`: annotated-hop acquisition records.

Run the offline reproduction commands in [`evidence-sufficiency-dynamics-20260915/REPRODUCE.md`](evidence-sufficiency-dynamics-20260915/REPRODUCE.md). They do not call a model service.
