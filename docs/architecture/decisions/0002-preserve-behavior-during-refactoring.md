# ADR 0002: Preserve behavior during structural refactoring

- Status: Accepted
- Date: 2026-08-05

## Context

Search ranking, prompts, tool schemas, SQLite data, and benchmark artifacts are observable behavior. Combining structural changes with algorithm changes would make regressions difficult to diagnose.

## Decision

Use characterization tests and branch-by-abstraction. During structural migration, preserve CLI flags, tool schemas, prompt text and hashes, database schema, search ordering, error behavior, and artifact formats.

## Consequences

- New and old facades may coexist temporarily.
- Every migration slice must typecheck and pass the relevant contract tests.
- Search-quality improvements occur only after structural migration is complete.
