import type { PicorerResult, PicorerRunError } from "../../evidence-agent/index.js";
import type { BenchmarkAnswerResult, BenchmarkFailureArtifacts } from "./answer.js";

export type EvidenceBenchmarkId = "ama-bench";

export type BenchmarkResponse = { kind: "text"; text: string };

export interface EvidenceBenchmarkPrediction {
  schema_version: 1;
  benchmark: EvidenceBenchmarkId;
  case_id: string;
  scope_id: string;
  response: BenchmarkResponse;
  abstention: boolean;
  retrieval_status: PicorerResult["status"];
  citations: PicorerResult["citations"];
  retrieval_model: PicorerResult["retrievalModel"];
  answer_model: BenchmarkAnswerResult["model"];
  answer_prompt: {
    adapter: string;
    version: string;
    hash: string;
  };
  run_id: string;
}

export interface EvidenceBenchmarkSuccessRecord {
  schema_version: 1;
  benchmark: EvidenceBenchmarkId;
  case_id: string;
  slot: number;
  prediction: EvidenceBenchmarkPrediction;
  retrieval: PicorerResult;
  answer: BenchmarkAnswerResult;
}

export interface EvidenceBenchmarkFailureRecord extends BenchmarkFailureArtifacts {
  schema_version: 1;
  benchmark: EvidenceBenchmarkId;
  case_id: string;
  slot: number;
  error: string;
  diagnostics?: PicorerRunError["diagnostics"];
}
