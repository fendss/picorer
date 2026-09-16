import type { MemoryCandidate } from "../../model/evidence.js";
import type { MemoryLedger } from "../../model/ledger.js";
import type { MemoryObservation } from "./memory-observation.js";
import { compactPreview, queryCenteredEpisodicPreview, sha256 } from "../../../util.js";

interface WorkingMemoryObservationOptions {
  recordShown?: (ref: string, text: string) => void;
  /** Re-expose the current result when earlier observations can leave context. */
  refreshResults?: boolean;
  /** Keep a bounded current page and a small unread shelf model-visible. */
  compact?: boolean;
}

const MAX_CURRENT_COMPACT_FINDINGS = 20;
const MAX_RETAINED_COMPACT_FINDINGS = 8;
const RETAINED_COMPACT_PREVIEW_CHARS = 160;

/** Navigation deltas only. The context policy supplies the persistent note. */
export function createWorkingMemoryObservation(
  ledger: MemoryLedger,
  maxSearchCalls?: number,
  options: WorkingMemoryObservationOptions = {},
) {
  const displayed = new Set<string>();
  let searches = 0;
  let pending: Parameters<MemoryObservation["recordSearch"]>[0] | undefined;
  let currentFindings: MemoryCandidate[] = [];
  let retainedFindings: MemoryCandidate[] = [];
  let lastRetainedSignature: string | undefined;

  function currentCandidate(candidate: MemoryCandidate): MemoryCandidate {
    return ledger.selectCandidates([candidate.candidateId])[0] ?? candidate;
  }

  function unread(findings: readonly MemoryCandidate[]): MemoryCandidate[] {
    return findings
      .map(currentCandidate)
      .filter((candidate) => !candidate.inspected);
  }

  function unique(findings: readonly MemoryCandidate[]): MemoryCandidate[] {
    const seen = new Set<string>();
    return findings.filter((candidate) => {
      if (seen.has(candidate.candidateId)) return false;
      seen.add(candidate.candidateId);
      return true;
    });
  }

  function renderRetainedFinding(candidate: MemoryCandidate): string | undefined {
    const ref = ledger.candidateRef(candidate.candidateId);
    if (ref === undefined) return undefined;
    const preview = candidate.passage?.content ?? candidate.preview;
    const text = compactPreview(preview, RETAINED_COMPACT_PREVIEW_CHARS);
    options.recordShown?.(ref, text);
    return `- read ${ref}${candidate.timestamp === undefined ? "" : ` · ${candidate.timestamp}`}\n  ${text}`;
  }

  function renderFinding(candidate: MemoryCandidate, limit: number): string | undefined {
    const ref = ledger.candidateRef(candidate.candidateId);
    if (ref === undefined) return undefined;
    const preview = candidate.passage?.content ?? candidate.preview;
    const queries = candidate.discoveries.flatMap(d => d.query ? [d.query] : []).slice(-2);
    const text = options.refreshResults
      ? queryCenteredEpisodicPreview(preview, queries.join(" "), limit)
      : compactPreview(preview, limit);
    // Include coordinates and displayed text: a known parent can expose a new fact.
    const identity = sha256(JSON.stringify([
      candidate.candidateId, candidate.passage?.sourceContentHash,
      candidate.passage?.start, candidate.passage?.end, text,
    ]));
    if (displayed.has(identity)) return undefined;
    displayed.add(identity);
    options.recordShown?.(ref, text);
    return `- read ${ref}${candidate.inspected ? (options.refreshResults ? " (previously read)" : " (previously read; new presentation)") : ""}` +
      `${options.refreshResults ? ` · ${candidate.role}` : ""}` +
      `${candidate.timestamp === undefined ? "" : ` · ${candidate.timestamp}`}\n  ${text}`;
  }

  return {
    searchesRemaining: () => maxSearchCalls === undefined ? undefined : Math.max(0, maxSearchCalls - searches),
    // The wrapper commits notes once for every tool, including finish.
    recordWorkingMemory() {
      throw new Error("Working-memory notes must be committed by the context policy");
    },
    recordSearch(input) {
      if (input.countsAgainstSearchBudget !== false) searches += 1;
      if (options.compact) {
        retainedFindings = unique([
          ...unread(currentFindings),
          ...unread(retainedFindings),
        ]).slice(0, MAX_RETAINED_COMPACT_FINDINGS);
        currentFindings = [...(input.findings ?? [])]
          .slice(0, MAX_CURRENT_COMPACT_FINDINGS);
        lastRetainedSignature = undefined;
      }
      pending = input;
    },
    render() {
      const current = pending;
      pending = undefined;
      // Deduplicate within this result only; a prior display is not current visibility.
      if (options.refreshResults) displayed.clear();
      const status = maxSearchCalls === undefined
        ? `Searches completed: ${searches}`
        : `Searches remaining: ${Math.max(0, maxSearchCalls - searches)}`;
      if (options.compact) {
        const findingLines = (current?.findings ?? []).flatMap((candidate) => {
          const line = renderFinding(candidate, 280);
          return line === undefined ? [] : [line];
        });
        const retained = unread(retainedFindings);
        const shelf = unique([
          ...unread(currentFindings),
          ...retained,
        ]);
        const retainedSignature = shelf.map((candidate) => candidate.candidateId).join("|");
        const showRetained = current === undefined && shelf.length > 0 &&
          retainedSignature !== lastRetainedSignature;
        const retainedLines = (showRetained ? shelf : current === undefined ? [] : retained)
          .flatMap((candidate) => {
            const line = renderRetainedFinding(candidate);
            return line === undefined ? [] : [line];
          });
        if (current === undefined) lastRetainedSignature = retainedSignature;
        return [
          "<MEMORY>",
          status,
          ...(current === undefined
            ? []
            : [
                "Current search results",
                ...findingLines,
                ...(findingLines.length === 0
                  ? ["No candidate text was returned for this page."]
                  : []),
                ...(current.pagination?.hasMore
                  ? ["More results are available through search_more."]
                  : []),
              ]),
          ...(retainedLines.length === 0
            ? []
            : [
                current === undefined
                  ? "Still-readable candidates from recent searches"
                  : "Still-readable candidates from an earlier search",
                ...retainedLines,
              ]),
          "Read promising candidates. Use source-supported facts for the next query; decide from the acquired evidence whether to search again or finish.",
          "</MEMORY>",
        ].join("\n");
      }
      const findingLines = (current?.findings ?? []).flatMap((candidate) => {
        const line = renderFinding(candidate, candidate.passage?.content.length ?? 360);
        return line === undefined ? [] : [line];
      });
      const directory = current?.directoryFindings ?? [];
      const directoryLimit = Math.max(48, Math.min(128, Math.floor(6_000 / Math.max(1, directory.length))));
      const directoryLines = directory.flatMap((candidate) => {
        const line = renderFinding(candidate, directoryLimit);
        return line === undefined ? [] : [line];
      });
      return [
        "<MEMORY>", status,
        `Stored candidates: ${ledger.candidates.length}; read sources: ${ledger.inspectedEvidence.length}.`,
        ...(current === undefined ? [] : [
          options.refreshResults ? "Findings from this search" : "New or changed findings from this search",
          ...findingLines,
          options.refreshResults ? "Compact directory from this search" : "New or changed compact directory entries",
          ...directoryLines,
          ...(findingLines.length + directoryLines.length === 0
            ? ["No new displayed text. This does not prove that the required evidence is complete."] : []),
          ...(current.pagination?.hasMore
            ? ["search_more can expand the next page of this search. Existing C refs remain readable."] : []),
          ...(current.operatorEvidence ? [current.operatorEvidence] : []),
          ...(current.planTrace ? [current.planTrace] : []),
        ]),
        "Candidate text is navigation for this decision. Read promising candidates before moving to another search; do not copy candidate handles into workingMemory.",
        "The harness retains every source returned by read and commits it to the final source package.",
        "</MEMORY>",
      ].join("\n");
    },
  } satisfies MemoryObservation & { searchesRemaining(): number | undefined };
}
