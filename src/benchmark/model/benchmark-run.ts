import type { PicorerResult, PicorerRunError } from "../../evidence-agent/index.js";
import type { BenchmarkAnswerResult, BenchmarkFailureArtifacts } from "./answer.js";

export interface BenchmarkPrediction {
  question_id: string;
  response: string;
  abstention: boolean;
  retrieval_status: PicorerResult["status"];
  citations: PicorerResult["citations"];
  count?: number;
  inventory?: PicorerResult["inventory"];
  metrics: PicorerResult["metrics"];
  retrieval: PicorerResult["retrieval"];
  retrieval_model: PicorerResult["retrievalModel"];
  answer_model: BenchmarkAnswerResult["model"];
  answer_prompt: {
    adapter: string;
    version: string;
    hash: string;
  };
  run_id: string;
}

export interface BenchmarkSuccessRecord {
  schema_version: 2;
  question_id: string;
  slot: number;
  prediction: BenchmarkPrediction;
  retrieval: PicorerResult;
  answer: BenchmarkAnswerResult;
}

export interface BenchmarkFailureRecord extends BenchmarkFailureArtifacts {
  schema_version: 1;
  question_id: string;
  slot: number;
  error: string;
  diagnostics?: PicorerRunError["diagnostics"];
}
