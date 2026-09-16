# ADR 0003: Executable architecture navigation

- Status: Accepted
- Date: 2026-08-05

## Context

A directory layout becomes unreliable documentation when files move without updating their stated responsibilities. A hand-maintained function list becomes stale even faster, and dependency rules expressed only in prose do not prevent the old coupling from returning.

## Decision

Generate the file and function catalogs from the source tree and TypeScript AST. Require an explicit responsibility for every primary source file, derive function purposes with curated descriptions for critical paths and JSDoc where present, and fail the normal check when either catalog is stale. Enforce stable context direction and public cross-context APIs with architecture tests.

## Consequences

- Every source file and callable symbol has one searchable navigation entry.
- Moving or adding code requires updating its documented responsibility deliberately.
- Dependency regressions fail tests instead of relying on code-review memory.
- Catalog generation changes documentation only; it does not affect runtime behavior.
