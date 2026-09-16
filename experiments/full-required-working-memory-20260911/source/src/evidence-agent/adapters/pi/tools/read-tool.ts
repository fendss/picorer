import type { CreatePicorerToolsOptions, PicorerTools, ReadToolDetails } from "./contracts.js";
import { uniqueCandidateRefs } from "./candidate-refs.js";
import { renderInspectedEvidence } from "./render-tool-result.js";
import {
  MAX_READ_RESULT_CHARS,
  projectMemoryEvidenceBatch,
  projectPassageEvidence,
  type MemoryEvidence,
} from "../../../model/source-evidence.js";
import { CompactReadParameters, ReadParameters } from "./schemas.js";
import { candidateToolDetails } from "./candidate-details.js";

const DEFAULT_LOCAL_CONTEXT_TURNS = 1;
const COMPACT_READ_RESULT_CHARS = 128 * 1024;
const COMPACT_MAX_CANDIDATES_PER_READ = 6;

export function createReadTool(
  options: CreatePicorerToolsOptions,
): PicorerTools["read"] {
  const compact = options.interfaceMode === "compact";
  const readResultChars = compact
    ? COMPACT_READ_RESULT_CHARS
    : MAX_READ_RESULT_CHARS;
  return {
    name: "read",
    label: "Read memory",
    description: compact
      ? "Read up to six visible candidate references. The harness promotes them to their immutable parent sources and retains provenance for final handoff."
      : "Read selected immutable sources into the final exact-source package using candidate handles such as C1. " +
        "The exact payload is retained privately under short E handles and every " +
        "source returned by read is automatically committed when finish succeeds. " +
        "One same-session turn on each side is included by default.",
    parameters: (compact
      ? CompactReadParameters
      : ReadParameters) as PicorerTools["read"]["parameters"],
    async execute(_toolCallId, params) {
      if (params.workingMemory !== undefined) {
        options.observation?.recordWorkingMemory(params.workingMemory);
      }
      const candidateRefs = uniqueCandidateRefs(params.candidateRefs);
      if (compact && candidateRefs.length > COMPACT_MAX_CANDIDATES_PER_READ) {
        throw new Error(
          `Compact read accepts at most ${String(COMPACT_MAX_CANDIDATES_PER_READ)} candidates.`,
        );
      }
      if (options.ledger.candidates.length === 0) {
        const contextBefore = compact ? 0 : params.contextBefore ?? DEFAULT_LOCAL_CONTEXT_TURNS;
        const contextAfter = compact ? 0 : params.contextAfter ?? DEFAULT_LOCAL_CONTEXT_TURNS;
        return {
          content: [{ type: "text", text: "No candidates exist. Call search again; do not guess a candidate handle." }],
          details: {
            kind: "read",
            requestedCandidateRefs: candidateRefs,
            requestedMemoryIds: [],
            contextBefore,
            contextAfter,
            evidence: [],
            evidenceReferences: [],
            expandedMemoryIds: [],
            candidates: [],
          },
        };
      }
      const selectedCandidates = options.ledger.resolveCandidates(candidateRefs);
      const memoryIds = [...new Set(
        selectedCandidates.map((candidate) => candidate.memoryId),
      )];
      const contextBefore = compact
        ? 0
        : params.contextBefore ?? DEFAULT_LOCAL_CONTEXT_TURNS;
      const contextAfter = compact
        ? 0
        : params.contextAfter ?? DEFAULT_LOCAL_CONTEXT_TURNS;
      const memories = options.store.read(
        options.scopeId,
        memoryIds,
        contextBefore,
        contextAfter,
      );
      const memoriesById = new Map(
        memories.map((memory) => [memory.memoryId, memory]),
      );
      for (const memoryId of memoryIds) {
        if (!memoriesById.has(memoryId)) {
          throw new Error(`Read did not return selected parent memory ${memoryId}`);
        }
      }
      const handoffEvidence = projectMemoryEvidenceBatch(memories, (memory) => {
        const candidates = options.ledger.selectMemoryCandidates([memory.memoryId]);
        return [
          ...(options.question === undefined ? [] : [options.question]),
          ...(options.evidenceFocus?.() ?? []),
          ...candidates.flatMap((candidate) =>
            candidate.discoveries.flatMap((discovery) =>
            discovery.query === undefined ? [] : [discovery.query]
          )),
        ];
      }, readResultChars, (memory) => options.ledger.sourceSpansFor(memory));
      const handoffByMemoryId = new Map(
        handoffEvidence.map((evidence) => [evidence.memoryId, evidence]),
      );
      const displayedEvidence: MemoryEvidence[] = [];
      const displayedCandidateIds: string[] = [];
      const displayedMemoryIds = new Set<string>();
      for (const candidate of selectedCandidates) {
        const memory = memoriesById.get(candidate.memoryId)!;
        if (candidate.passage !== undefined) {
          displayedEvidence.push(projectPassageEvidence(memory, candidate.passage));
          displayedCandidateIds.push(candidate.candidateId);
          displayedMemoryIds.add(candidate.memoryId);
          continue;
        }
        if (displayedMemoryIds.has(candidate.memoryId)) continue;
        const evidence = handoffByMemoryId.get(candidate.memoryId);
        if (evidence === undefined) {
          throw new Error(`Read did not project selected parent memory ${candidate.memoryId}`);
        }
        displayedMemoryIds.add(candidate.memoryId);
        displayedEvidence.push(evidence);
        displayedCandidateIds.push(candidate.candidateId);
      }
      for (const evidence of handoffEvidence) {
        if (displayedMemoryIds.has(evidence.memoryId)) continue;
        displayedMemoryIds.add(evidence.memoryId);
        displayedEvidence.push(evidence);
        displayedCandidateIds.push(evidence.memoryId);
      }
      const renderedChars = displayedEvidence.reduce(
        (sum, evidence) => sum + evidence.content.length,
        0,
      );
      if (renderedChars > readResultChars) {
        throw new Error(
          `Read result would exceed ${String(readResultChars)} characters. ` +
            "Read fewer candidate passages or request less neighboring context.",
        );
      }
      const inspectedCandidateIds = selectedCandidates.map(
        (candidate) => candidate.candidateId,
      );
      const recorded = options.ledger.recordInspect(
        handoffEvidence,
        undefined,
        inspectedCandidateIds,
      );
      const requested = new Set(memoryIds);
      const expandedMemoryIds = recorded
        .map((memory) => memory.memoryId)
        .filter((memoryId) => !requested.has(memoryId));
      const candidates = options.ledger.selectCandidates([
        ...inspectedCandidateIds,
        ...expandedMemoryIds,
      ]);
      const renderedCandidateIds = recorded.map((memory) =>
        selectedCandidates.find((candidate) =>
          candidate.memoryId === memory.memoryId
        )?.candidateId ?? memory.memoryId
      );
      const evidenceReferences = recorded.map((memory, index) => ({
        evidenceRef: options.ledger.evidenceRef(memory.memoryId)!,
        candidateRef: options.ledger.candidateRef(
          renderedCandidateIds[index] ?? memory.memoryId,
        )!,
        memoryId: memory.memoryId,
      }));
      const details: ReadToolDetails = {
        kind: "read",
        requestedCandidateRefs: candidateRefs,
        requestedMemoryIds: memoryIds,
        contextBefore,
        contextAfter,
        evidence: recorded.map((item) => ({
          memoryId: item.memoryId,
          scopeId: item.scopeId,
          sessionId: item.sessionId,
          turnIndex: item.turnIndex,
          contentHash: item.contentHash,
          sourceContentHash: item.sourceContentHash,
          sourceContentLength: item.sourceContentLength,
          truncated: item.truncated,
          excerpts: item.excerpts.map((excerpt) => ({
            start: excerpt.start,
            end: excerpt.end,
          })),
        })),
        evidenceReferences,
        expandedMemoryIds,
        candidates: candidateToolDetails(candidates),
      };
      return {
        content: [{
          type: "text",
          text: [
            "<READ_RESULT>",
            "Inspected exact passages (visible for this reasoning turn). " +
              "Their immutable parent sources are retained privately for final handoff:",
            renderInspectedEvidence(
              displayedEvidence,
              options.ledger,
              options.questionDate,
              displayedCandidateIds,
            ),
            "Every exact parent-backed evidence item selected above will be committed when finish succeeds.",
            "</READ_RESULT>",
            ...(options.observation === undefined
              ? []
              : ["", options.observation.render()]),
          ].join("\n"),
        }],
        details,
      };
    },
  };
}
