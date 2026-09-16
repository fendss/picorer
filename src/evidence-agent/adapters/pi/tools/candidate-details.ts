import type { MemoryCandidate } from "../../../model/evidence.js";
import type { CandidateToolDetails } from "./contracts.js";

/** Keeps exact text in preview once, while retaining passage provenance. */
export function candidateToolDetails(
  candidates: readonly MemoryCandidate[],
): CandidateToolDetails[] {
  return candidates.map((candidate) => {
    if (candidate.passage === undefined) return { ...candidate };
    const { content: _content, ...passage } = candidate.passage;
    return { ...candidate, passage };
  });
}
