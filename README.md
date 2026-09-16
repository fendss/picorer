<div align="center">
  <img src="assets/picorer-logo.png" alt="Picorer" width="760">

  <p><strong>Source-grounded memory for agents.</strong></p>

  <p>
    Picorer helps AI agents explore long-lived memory, inspect original records,<br>
    and hand off verifiable evidence for answers and actions.
  </p>

  <p>
    <a href="docs/picorer-v1.0.0/README.md">Documentation</a> ·
    <a href="docs/architecture/README.md">Architecture</a> ·
    <a href="experiments/README.md">Experiments</a> ·
    <a href="RELEASE.md">Release notes</a>
  </p>

  <p>
    <img alt="Release v1.0.0" src="https://img.shields.io/badge/release-v1.0.0-4B1D72?style=flat-square">
    <img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-4B1D72?style=flat-square">
    <img alt="Apache 2.0 License" src="https://img.shields.io/badge/license-Apache--2.0-4B1D72?style=flat-square">
  </p>
</div>

---

## Memory that stays inspectable

Picorer is an open-source memory system for AI agents. It keeps the original
memory intact while an agent searches, reads, and assembles the evidence needed
for the task at hand.

Instead of hiding retrieval behind a single opaque lookup, Picorer makes the
acquisition process explicit. The result is a compact evidence package that can
be inspected, evaluated, and passed to any answer or action layer.

## Why Picorer

- **Evidence before answers** — outputs remain connected to the exact records
  the agent inspected.
- **Agent-directed retrieval** — the agent can refine its search as its
  understanding of the task develops.
- **Immutable source memory** — retrieval and indexing never rewrite the
  original record.
- **Evaluation-ready** — provenance and acquisition traces make memory behavior
  easier to study and reproduce.

## The basic idea

```text
Long-lived memory  →  Search and inspect  →  Evidence package  →  Answer or action
```

Picorer focuses on the middle of this flow: helping an agent acquire enough
grounded evidence without taking ownership of the final application response.

## Quick start

Picorer requires Node.js 22.19 or newer.

```bash
git clone https://github.com/fendss/picorer.git
cd picorer
npm ci
npm run build
```

Continue with the [evaluation and usage guide](docs/picorer-v1.0.0/05-evaluation-guide.md),
or see the [deployment guide](deploy/README.md) for a service setup.

## Explore the project

| | |
|---|---|
| **[System guide](docs/picorer-v1.0.0/README.md)** | The complete design, usage, evaluation, and operations guide. |
| **[Architecture](docs/architecture/README.md)** | A map of the system and its major components. |
| **[Experiments](experiments/README.md)** | Released data, analyses, figures, and reproducibility material. |
| **[Release boundary](RELEASE.md)** | What is included in the independent Picorer v1.0.0 release. |

## Research and evaluation

The repository includes benchmark integrations and research artifacts for
studying agentic memory acquisition, evidence coverage, and perceived
sufficiency. Experimental results are kept alongside their analysis code and
integrity records so that claims can be traced back to released data.

## License

Picorer is released under the [Apache License 2.0](LICENSE).
