import type { ModelMetadata, ModelUsage, PicorerResult } from "../../evidence-agent/index.js";
import { responseModelMatchesRequested } from "../../util.js";

/** Benchmark-owned prompt handed to an answer-model adapter. */
export interface BenchmarkAnswerPrompt {
  adapterId: string;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
}

export const BENCHMARK_ANSWER_EXECUTION_CHECKLIST = `<answer_execution>
- Evaluate every requested item or answer option independently against the source memories before composing the final answer.
- For lists and multi-select questions, include every supported item and no unsupported item.
- For ordering questions, reconstruct local event transitions first, then obey the requested forward, backward, nearest-first, or farthest-first direction. Retrieval rank is not chronology.
- Follow the caller's exact output syntax. Emit only the final answer and do not expose memory IDs, ranks, scores, or retrieval metadata.
</answer_execution>`;

/** Provider-neutral answer outcome persisted by benchmark runs. */
export interface BenchmarkAnswerResult {
  answer: string;
  promptAdapter: string;
  promptVersion: string;
  promptHash: string;
  model: ModelMetadata & {
    responseModel: string;
  };
  usage: ModelUsage;
}

export type BenchmarkAnswerFailureDiagnostics = Pick<BenchmarkAnswerResult,
  "promptAdapter" | "promptVersion" | "promptHash" | "usage">;

/** A failed answer still owns its provider usage and exact prompt identity. */
export class BenchmarkAnswerError extends Error {
  constructor(message: string, readonly diagnostics: BenchmarkAnswerFailureDiagnostics) {
    super(message);
    this.name = "BenchmarkAnswerError";
  }
}

/** Preserve completed stages even when a later stage or artifact write fails. */
export interface BenchmarkFailureArtifacts {
  retrieval?: PicorerResult;
  answer?: BenchmarkAnswerResult;
  answerDiagnostics?: BenchmarkAnswerFailureDiagnostics;
}

export function returnedModelMatches(requested: string, returned: string): boolean {
  return responseModelMatchesRequested(requested, returned);
}
