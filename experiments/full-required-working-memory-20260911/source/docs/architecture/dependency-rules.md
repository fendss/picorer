# Dependency Rules

## Context Rules

1. `memory` imports no other domain context.
2. `retrieval` may import only the public API of `memory`.
3. `evidence-agent` may import only the public APIs of `retrieval` and `memory`.
4. `agent-runtime` may import the public APIs of `evidence-agent`, `retrieval`, and `memory`.
5. `benchmark` may import the public APIs of the other contexts.
6. Cross-context imports target the context `index.ts`, never an internal adapter or implementation file.

## Layer Rules

1. `model` imports neither `use-cases`, `ports`, nor `adapters`.
2. `use-cases` may import `model` and `ports`, but not `adapters`.
3. `ports` use context-owned model types and contain no technology-specific types.
4. `adapters` implement ports and may depend on external libraries.
5. `entrypoints` and `composition` are the outer wiring layers. Reusable cross-context construction belongs in `composition`; command-specific process and artifact wiring stays in `entrypoints`.

## Data Boundaries

- SQLite rows are converted to context models inside SQLite adapters.
- Pi Agent SDK messages stay inside the Pi adapter.
- OpenAI-compatible HTTP payloads stay inside the embedding adapter.
- Dataset rows, private labels, judge inputs, scoring artifacts, and benchmark
  manifests remain in `benchmark` and its entrypoints.
- Core memory validates domain data as JSON; the benchmark label firewall runs
  at benchmark ingress before those sessions are passed into core ingest.
- The evidence agent returns source-grounded evidence and never formats an
  evaluation-specific answer.

The inward context direction, public cross-context API rule, model isolation,
and absence of evaluation vocabulary in core contexts are enforced by
`test/architecture/dependency-rules.test.ts`.
