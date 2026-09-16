import type { MemoryEvidence } from "../../../model/source-evidence.js";
import {
  temporalAnnotation,
  type EvidenceOperatorResult,
} from "../../../../retrieval/index.js";
import type { MemoryCandidate } from "../../../model/evidence.js";
import type { MemoryLedger } from "../../../model/ledger.js";

function temporalSuffix(
  timestamp: string | undefined,
  questionDate: string | undefined,
): string {
  const annotation = temporalAnnotation(timestamp, questionDate);
  return annotation ? ` (${annotation})` : "";
}

export function renderEvidenceOperator(
  result: EvidenceOperatorResult | undefined,
  ledger: MemoryLedger,
): string {
  if (!result) return "";
  const heading = result.operator === "temporal"
    ? "Temporal evidence:"
    : "Numeric evidence:";
  const displayTruncated = result.rows.length > 16;
  const rows = result.rows.slice(0, 16).map((row) => {
    const temporal = row.eventTime === undefined ? "" : ` | event_time=${row.eventTime}`;
    const mentions = row.mentionedDates === undefined
      ? ""
      : ` | mentioned_dates=${row.mentionedDates.join(",")}`;
    const occurrence = row.sourceSpan === undefined ? "" : `:chars:${row.sourceSpan.start}-${row.sourceSpan.end}`;
    const numeric = row.value === undefined
      ? ""
      : ` | value=${String(row.value)} ${row.unit ?? ""} | value_kind=${row.valueKind ?? "unknown"} | occurrence_ref=candidate:${String(ledger.candidateRefForQuote(row.memoryId, row.quote))}${occurrence}`;
    const candidateRef = ledger.candidateRefForQuote(row.memoryId, row.quote);
    return `- [candidate:${String(candidateRef ?? "unavailable")}] | slot=${JSON.stringify(row.slot)}${temporal}${mentions}${numeric} | ${row.quote}`;
  });
  const plan = result.temporalPlan === undefined
    ? []
    : [`temporal_plan=${JSON.stringify(result.temporalPlan)}`];
  const derivedForAgent = result.derived === undefined || displayTruncated || result.coverage.truncated
    ? undefined
    : Object.fromEntries(Object.entries(result.derived).map(([key, value]) => {
        if (key === "latestMemoryId" && typeof value === "string") {
          return ["latestCandidateRef", ledger.candidateRef(value)];
        }
        if (key === "includedMemoryIds" && Array.isArray(value)) {
          return ["includedCandidateRefs", value.map((memoryId) =>
            typeof memoryId === "string" ? ledger.candidateRef(memoryId) : undefined
          ).filter((item) => item !== undefined)];
        }
        if (key === "includedDedupeKeys" && Array.isArray(value)) {
          return ["includedOccurrenceCount", value.length];
        }
        return [key, value];
      }));
  const derived = derivedForAgent === undefined
    ? []
    : [`derived=${JSON.stringify(derivedForAgent)}`];
  return [
    heading,
    ...plan,
    ...rows,
    ...derived,
    `coverage=${JSON.stringify({ ...result.coverage, truncated: result.coverage.truncated || displayTruncated })}`,
  ].join("\n");
}

export function renderCandidates(
  candidates: readonly MemoryCandidate[],
  ledger: MemoryLedger,
  questionDate?: string,
): string {
  if (candidates.length === 0) return "No memory candidates found.";
  const lines = candidates.map((candidate) => {
    const time = candidate.timestamp ? ` | session_time=${candidate.timestamp}` : "";
    const discovery = [...candidate.discoveries]
      .reverse()
      .find((item) => item.tool === "search" && item.query);
    const matched = discovery?.query === undefined
      ? ""
      : ` | matched_query=${JSON.stringify(discovery.query)} | rank=${String(discovery.rank ?? "unknown")}`;
    return `- [candidate:${String(ledger.candidateRef(candidate.candidateId))}]${time}${temporalSuffix(candidate.timestamp, questionDate)} | turn=${String(candidate.turnIndex)} | role=${candidate.role}${matched} | ${candidate.preview}`;
  });
  return [
    `candidate_refs=${JSON.stringify(candidates.map((candidate) => ledger.candidateRef(candidate.candidateId)))}`,
    ...lines,
  ].join("\n");
}

export function renderInspectedEvidence(
  memories: readonly MemoryEvidence[],
  ledger: MemoryLedger,
  questionDate?: string,
  candidateIds: readonly string[] = [],
): string {
  return memories
    .map((memory, index) => {
      const time = memory.timestamp ? ` ${memory.timestamp}` : "";
      const projection = memory.truncated
        ? ` | bounded_exact_excerpts=true | source_chars=${String(memory.sourceContentLength)}`
        : "";
      const candidateId = candidateIds[index] ?? memory.memoryId;
      return `[evidence:${String(ledger.evidenceRef(memory.memoryId))}; ` +
        `candidate:${String(ledger.candidateRef(candidateId))}; ` +
        `read:true; auto_commit_on_finish:true]${time}` +
        `${temporalSuffix(memory.timestamp, questionDate)} ${memory.role}` +
        `${projection}\n${memory.content}`;
    })
    .join("\n\n");
}
