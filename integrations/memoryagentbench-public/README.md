# MemoryAgentBench operator-evolution track

This integration materializes ten pinned MemoryAgentBench slices without
committing benchmark data or credentials. It intentionally reports two tracks:

- `refind-comparable`: RULER-QA1, Fact-SH/MH-6K, EventQA-64K and
  LongMemEval-S.
- `ttl-extension`: Banking77, CLINC150, NLU, TREC-Coarse and TREC-Fine.

The second track is useful, but it is not part of ReFind's six-capability main
MemoryAgentBench result and must not be folded into a purported reproduction
of that number.

## Hydrate

```bash
uv run --with-requirements integrations/memoryagentbench-public/requirements.lock.txt \
  python integrations/memoryagentbench-public/hydrate.py \
  --output /data/memoryagentbench-picorer/input \
  --cache /data/memoryagentbench-picorer/cache
```

`pins.json` locks the upstream repository commit, Hugging Face dataset
revision, every downloaded parquet SHA-256, the tokenizer, and the 4096-token
chunking rule. The hydrator reproduces MemoryAgentBench's sentence-boundary
chunker and stores each unchanged chunk as one Picorer memory record.

The output separates `public/` context/question files from mode-0600
`private/gold/` files. LongMemEval's auxiliary `has_answer` metadata is not
copied. `manifest.json` records the SHA-256 and size of every artifact.

## Evolution conditions

Run each context's questions in the published order and reset both memory and
the evolution catalog at the context boundary:

1. `static`: custom operator definitions disabled.
2. `ephemeral`: definitions may be built inside a question, then discarded.
3. `cumulative`: query-agnostic definitions that executed and contributed a
   cited memory may be offered to later questions in the same context.

The cumulative catalog observes only the retrieval result. Gold answers,
automatic metrics and LongMemEval judge outputs are evaluated after the
catalog state has been committed and are never evolution inputs. Persisted
plans cannot contain fixed search queries, two distinct successful questions
are required for promotion, and one definition slot remains open for
exploration.

For direct comparison with ReFind, use GPT-4o-mini at temperature zero for
retrieval control and final answers, at most four retrieval iterations, and
the official task prompts/metrics. Report per-subset results and the two tracks
separately.
