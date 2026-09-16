import type { MemoryLedger } from "../../model/ledger.js";
import { queryCenteredEpisodicPreview } from "../../../util.js";

/** Bounded excerpts of actual reads, independent of model-authored progress. */
export function renderReadReceipts(ledger: MemoryLedger): string {
  const evidence = ledger.inspectedEvidence;
  const candidates = ledger.candidates.filter(candidate => candidate.inspected);
  const previewLimit = Math.min(160, Math.max(40, Math.floor(6_000 / Math.max(1, evidence.length))));
  const lines = evidence.map(source => {
    const readCandidates = candidates.filter(candidate => candidate.memoryId === source.memoryId);
    const refs = readCandidates.map(candidate => ledger.candidateRef(candidate.candidateId)!);
    const queries = readCandidates.flatMap(candidate =>
      candidate.discoveries.flatMap(discovery => discovery.query ? [discovery.query] : [])
    ).slice(-2);
    return `- ${refs.join(", ")} · read · ${source.role}` +
      `${source.timestamp === undefined ? "" : ` · ${source.timestamp}`}\n  ` +
      queryCenteredEpisodicPreview(source.content, queries.join(" "), previewLimit);
  });
  return [
    '<READ_SOURCES authority="program-read-ledger">',
    "Already read sources (short excerpts; use read with a listed C ref for exact wording):",
    ...(lines.length ? lines : ["None."]),
    "</READ_SOURCES>",
  ].join("\n");
}
