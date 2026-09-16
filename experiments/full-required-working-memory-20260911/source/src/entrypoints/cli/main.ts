#!/usr/bin/env node
import { benchmarkLongMemEval } from "./commands/benchmark-longmemeval.js";
import { benchmarkMemoryAgentBench } from "./commands/benchmark-memoryagentbench.js";
import { benchmarkEvidence } from "./commands/benchmark-evidence.js";
import { evaluateBenchmark } from "./commands/evaluate-benchmark.js";
import { ingestBenchmark } from "./commands/ingest-benchmark.js";
import { ingestLongMemEval } from "./commands/ingest-longmemeval.js";
import { ingestTauKnowledge } from "./commands/ingest-tau-knowledge.js";
import { longMemEvalSuite } from "./commands/longmemeval-suite.js";
import { packageBenchmark } from "./commands/package-benchmark.js";
import { prepareLongMemEvalEvaluation } from "./commands/prepare-longmemeval-eval.js";
import { runLongMemEval } from "./commands/run-longmemeval.js";
import { runGeneric } from "./commands/run-memory.js";
import { parseCommand } from "./parse-command.js";

function printHelp(): void {
  process.stdout.write(`Picorer \u2014 minimal source-grounded memory agent

Commands:
  ingest-benchmark --benchmark ama-bench --source FILE --data-dir DIR [--case-id ID ...] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1]
  benchmark        --benchmark ama-bench --data-dir DIR --output-dir DIR [--case-id ID ...] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--skill none|picorer-v0] [--model-adapter ID] [--model ID] [--slots N] [--stage-timeout-ms N] [--resume-infrastructure-only true]
  evaluate-benchmark --benchmark ama-bench --data-dir DIR --predictions FILE --output FILE [--judge-model ID] [--slots N] [--stage-timeout-ms N]
  ingest-longmemeval --source FILE --data-dir DIR [--question-id ID ...] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--embedding-slots N] [--embedding-rps N]
  ingest-tau-knowledge --tau-root DIR --data-dir DIR [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--embedding-slots N] [--embedding-rps N]
  run-longmemeval    --data-dir DIR --question-id ID [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--model ID] [--skill none|picorer-v0]
  benchmark-longmemeval --data-dir DIR --output-dir DIR [--question-id ID ...] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--model ID] [--skill none|picorer-v0] [--slots N]
  benchmark-memoryagentbench --input-dir DIR --output-dir DIR --subset ID [--evolution static|ephemeral|cumulative] [--question-limit N] [--max-search-calls N] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--model ID]
  longmemeval-suite --source FILE --data-dir DIR --output-dir DIR --embedding-env FILE --answer-env FILE --judge-env FILE --retrieval-agent-dir DIR --retrieval-provider ID --retrieval-model ID --answer-agent-dir DIR --answer-provider ID --answer-model ID --archive FILE.tar.gz --evaluation-archive FILE.tar.gz [--retrieval-env FILE] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--skill none|picorer-v0] [--slots N] [--frozen-slots N] [--judge-slots N]
  prepare-longmemeval-eval --source FILE --predictions FILE --output FILE
  package-benchmark   --output-dir DIR --archive FILE.tar.gz
  run                 --data-dir DIR --scope ID --question TEXT [--question-date TEXT] [--retrieval-profile fts5|picorer-hybrid|picorer-hybrid-qdrant-hnsw-v1] [--model ID] [--skill none|picorer-v0]
`);
}

async function main(): Promise<void> {
  const parsed = parseCommand(process.argv.slice(2));
  switch (parsed.command) {
    case "ingest-benchmark":
      await ingestBenchmark(parsed);
      return;
    case "benchmark":
      await benchmarkEvidence(parsed);
      return;
    case "evaluate-benchmark":
      await evaluateBenchmark(parsed);
      return;
    case "ingest-longmemeval":
      await ingestLongMemEval(parsed);
      return;
    case "ingest-tau-knowledge":
      await ingestTauKnowledge(parsed);
      return;
    case "run-longmemeval":
      await runLongMemEval(parsed);
      return;
    case "benchmark-longmemeval":
      await benchmarkLongMemEval(parsed);
      return;
    case "benchmark-memoryagentbench":
      await benchmarkMemoryAgentBench(parsed);
      return;
    case "longmemeval-suite":
      await longMemEvalSuite(parsed);
      return;
    case "prepare-longmemeval-eval":
      await prepareLongMemEvalEvaluation(parsed);
      return;
    case "package-benchmark":
      await packageBenchmark(parsed);
      return;
    case "run":
      await runGeneric(parsed);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Picorer error: ${message}\n`);
  process.exitCode = 1;
});
