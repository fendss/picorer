# ADR 0001: Domain-oriented modular monolith

- Status: Accepted
- Date: 2026-08-05

## Context

The initial flat source directory mixed immutable memory management, retrieval algorithms, Agent protocol, external adapters, and benchmark orchestration. Large files accumulated multiple reasons to change and concrete store types leaked into ranking and Agent code.

## Decision

Organize the source by four bounded contexts: `memory`, `retrieval`, `evidence-agent`, and `benchmark`. Keep one deployment unit. Inside a context, separate model, use cases, ports, and adapters only where a real technology boundary exists.

## Consequences

- The top-level tree describes product capabilities.
- Contexts expose explicit public APIs.
- SQLite, Pi Agent, OpenAI, Docker, filesystem, and Python remain replaceable details.
- Migration used temporary compatibility facades and characterization tests;
  the facades were removed after all internal consumers moved to canonical
  context APIs.
