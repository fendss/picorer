import {
  retrievalHitIdentity,
  sourceQuoteMatchScore,
  type MemoryPassage,
  type RetrievalHit,
} from "../../retrieval/index.js";
import type {
  Citation,
  MemoryCandidate,
  PicorerSelection,
} from "./evidence.js";
import type { MemoryRecord } from "../../memory/index.js";
import {
  MAX_INSPECTED_EVIDENCE_COUNT,
  MAX_INSPECTED_EVIDENCE_CHARS,
  mergeMemoryEvidence,
  mergeSpans,
  type MemoryEvidence,
  type SourceSpan,
} from "./source-evidence.js";
import { candidatePreview, sourcePreviewSpans } from "./source-preview-spans.js";
import { compactPreview } from "../../util.js";

function cloneCandidate(candidate: MemoryCandidate): MemoryCandidate {
  return {
    ...candidate,
    ...(candidate.passage === undefined
      ? {}
      : { passage: { ...candidate.passage } }),
    discoveries: candidate.discoveries.map((discovery) => ({
      ...discovery,
      ...(discovery.metadataFilters === undefined
        ? {}
        : {
            metadataFilters: discovery.metadataFilters.map((filter) => ({
              ...filter,
            })),
          }),
    })),
  };
}

function cloneEvidence(evidence: MemoryEvidence): MemoryEvidence {
  return structuredClone(evidence);
}

function cloneSelection(selection: PicorerSelection): PicorerSelection {
  return {
    ...selection,
    citations: selection.citations.map((citation) => ({ ...citation })),
    ...(selection.inventory === undefined
      ? {}
      : {
          inventory: selection.inventory.map((item) => ({
            item: item.item,
            memoryIds: [...item.memoryIds],
          })),
        }),
  };
}

/**
 * Per-question, in-memory provenance ledger.
 *
 * The only legal state transition is:
 *
 *   candidate -> read exact evidence -> automatically committed evidence
 *
 * Raw records are never inferred from model output. Search and read add them
 * from structured store results. Finish commits the complete read ledger and
 * the harness derives citations and provenance from it.
 */
export class MemoryLedger {
  readonly scopeId: string;

  private readonly candidatesById = new Map<string, MemoryCandidate>();
  private readonly candidateIdsByMemoryId = new Map<string, Set<string>>();
  private sourceSpansByCandidateId = new Map<string, {
    sourceContentHash: string;
    spans: SourceSpan[];
  }>();
  private evidenceById = new Map<string, MemoryEvidence>();
  private readonly candidateRefById = new Map<string, string>();
  private readonly candidateIdByRef = new Map<string, string>();
  private readonly evidenceRefById = new Map<string, string>();
  private acceptedSelection: PicorerSelection | undefined;
  private step = 0;

  constructor(scopeId: string) {
    const normalizedScopeId = scopeId.trim();
    if (!normalizedScopeId) {
      throw new Error("scopeId must not be empty");
    }
    this.scopeId = normalizedScopeId;
  }

  nextStep(): number {
    this.step += 1;
    return this.step;
  }

  get candidates(): MemoryCandidate[] {
    return [...this.candidatesById.values()].map(cloneCandidate);
  }

  get inspectedEvidence(): MemoryEvidence[] {
    return [...this.evidenceById.values()].map(cloneEvidence);
  }

  get citations(): Citation[] {
    return (
      this.acceptedSelection?.citations.map((citation) => ({ ...citation })) ??
      []
    );
  }

  get selection(): PicorerSelection | undefined {
    return this.acceptedSelection
      ? cloneSelection(this.acceptedSelection)
      : undefined;
  }

  get inspectedIds(): ReadonlySet<string> {
    return new Set(this.evidenceById.keys());
  }

  hasInspected(memoryId: string): boolean {
    return this.evidenceById.has(memoryId);
  }

  candidateRef(candidateOrMemoryId: string): string | undefined {
    const direct = this.candidateRefById.get(candidateOrMemoryId);
    if (direct !== undefined) return direct;
    const candidateId = this.candidateIdsByMemoryId.get(candidateOrMemoryId)
      ?.values().next().value as string | undefined;
    return candidateId === undefined
      ? undefined
      : this.candidateRefById.get(candidateId);
  }

  candidateRefForQuote(memoryId: string, quote: string): string | undefined {
    const candidates = this.selectMemoryCandidates([memoryId]);
    const best = candidates
      .map((candidate) => ({
        candidate,
        score: sourceQuoteMatchScore(
          candidate.passage?.content ?? candidate.preview,
          quote,
        ),
      }))
      .sort((left, right) => right.score - left.score)[0];
    return best !== undefined && best.score > 0
      ? this.candidateRef(best.candidate.candidateId)
      : this.candidateRef(memoryId);
  }

  evidenceRef(memoryId: string): string | undefined {
    return this.evidenceRefById.get(memoryId);
  }

  resolveCandidateRefs(refs: readonly string[]): string[] {
    return this.resolveCandidates(refs).map((candidate) => candidate.memoryId);
  }

  resolveCandidates(refs: readonly string[]): MemoryCandidate[] {
    return [...new Set(refs)].map((ref) => {
      const candidateId = this.candidateIdByRef.get(ref);
      const candidate = candidateId === undefined
        ? undefined
        : this.candidatesById.get(candidateId);
      if (candidate === undefined) {
        throw new Error(
          `Unknown candidate reference ${ref}. Valid candidate range is ` +
            `${this.candidateIdByRef.size === 0 ? "empty" : `C1-C${String(this.candidateIdByRef.size)}`}.`,
        );
      }
      return cloneCandidate(candidate);
    });
  }

  selectCandidates(candidateOrMemoryIds: readonly string[]): MemoryCandidate[] {
    const selected: MemoryCandidate[] = [];
    const seen = new Set<string>();
    for (const identity of new Set(candidateOrMemoryIds)) {
      const direct = this.candidatesById.get(identity);
      const candidates = direct === undefined
        ? [...(this.candidateIdsByMemoryId.get(identity) ?? [])]
          .map((candidateId) => this.candidatesById.get(candidateId))
          .filter((candidate): candidate is MemoryCandidate => candidate !== undefined)
        : [direct];
      for (const candidate of candidates) {
        if (seen.has(candidate.candidateId)) continue;
        seen.add(candidate.candidateId);
        selected.push(cloneCandidate(candidate));
      }
    }
    return selected;
  }

  /** Returns every passage/legacy candidate belonging to the given parents. */
  selectMemoryCandidates(memoryIds: readonly string[]): MemoryCandidate[] {
    const selected: MemoryCandidate[] = [];
    for (const memoryId of new Set(memoryIds)) {
      for (const candidateId of this.candidateIdsByMemoryId.get(memoryId) ?? []) {
        const candidate = this.candidatesById.get(candidateId);
        if (candidate !== undefined) selected.push(cloneCandidate(candidate));
      }
    }
    return selected;
  }

  /** Source-bound search fragments survive later searches and preview changes. */
  sourceSpansFor(record: MemoryRecord): SourceSpan[] {
    return mergeSpans(this.selectMemoryCandidates([record.memoryId]).flatMap((candidate) => {
      const source = this.sourceSpansByCandidateId.get(candidate.candidateId);
      if (source === undefined) return [];
      if (source.sourceContentHash !== record.contentHash) {
        throw new Error(`Candidate source changed before read: ${record.memoryId}`);
      }
      return source.spans;
    }));
  }

  recordSearchHits(
    hits: readonly RetrievalHit[],
    step = this.nextStep(),
  ): MemoryCandidate[] {
    for (const hit of hits) this.assertScope(hit.record);
    const nextSpans = new Map(this.sourceSpansByCandidateId);
    for (const hit of hits) {
      const id = retrievalHitIdentity(hit);
      const existing = nextSpans.get(id);
      if (existing !== undefined && existing.sourceContentHash !== hit.record.contentHash) {
        throw new Error(`Immutable candidate source changed during search: ${hit.record.memoryId}`);
      }
      const spans = hit.passage === undefined
        ? sourcePreviewSpans(hit.record.content, candidatePreview(hit))
        : hit.passage.end > hit.passage.start
          ? [{ start: hit.passage.start, end: hit.passage.end }]
          : [];
      nextSpans.set(id, {
        sourceContentHash: hit.record.contentHash,
        spans: mergeSpans([...(existing?.spans ?? []), ...spans]),
      });
    }
    this.sourceSpansByCandidateId = nextSpans;
    for (const hit of hits) {
      const candidateId = retrievalHitIdentity(hit);
      for (const query of hit.matchedQueries ?? [hit.query]) {
        const metadataFilters = hit.matchedMetadataFilters?.filter(
          (filter) => filter.query === query,
        );
        this.upsertCandidate(candidateId, hit.record, candidatePreview(hit), {
          step,
          tool: "search",
          query,
          retriever: hit.retriever,
          rank: hit.rank,
          score: hit.score,
          ...(metadataFilters === undefined || metadataFilters.length === 0
            ? {}
            : {
                metadataFilters: metadataFilters.map((filter) => ({
                  ...filter,
                })),
              }),
        }, hit.passage);
      }
    }
    this.assertInvariants();
    return this.selectCandidates(hits.map(retrievalHitIdentity));
  }

  /**
   * Records bounded exact source excerpts returned by inspect.
   *
   * Context neighbors (and direct IDs discovered through bash) may not have
   * appeared in search. They are first promoted to candidates with an explicit
   * read_expansion provenance entry, then marked as inspected evidence.
   */
  recordInspect(
    evidenceRecords: readonly MemoryEvidence[],
    step = this.nextStep(),
    inspectedCandidateIds: readonly string[] = [],
  ): MemoryEvidence[] {
    // A successful read enters the final exact-source package. Bound the ledger
    // before mutating it so the all-read handoff remains atomic.
    const nextEvidenceById = new Map<string, MemoryEvidence>(
      [...this.evidenceById].map(([memoryId, evidence]) => [
        memoryId,
        cloneEvidence(evidence),
      ] as const),
    );
    for (const evidence of evidenceRecords) {
      this.assertScope(evidence);
      const existingEvidence = nextEvidenceById.get(evidence.memoryId);
      nextEvidenceById.set(
        evidence.memoryId,
        existingEvidence === undefined
          ? cloneEvidence(evidence)
          : mergeMemoryEvidence(existingEvidence, evidence),
      );
    }
    if (nextEvidenceById.size > MAX_INSPECTED_EVIDENCE_COUNT) {
      throw new Error(
        `Read rejected: retaining this batch would exceed the inspected ` +
          `evidence limit of ${String(MAX_INSPECTED_EVIDENCE_COUNT)} memories. ` +
          "No source from this read was retained.",
      );
    }
    const nextEvidenceChars = [...nextEvidenceById.values()].reduce(
      (sum, evidence) => sum + evidence.content.length,
      0,
    );
    if (nextEvidenceChars > MAX_INSPECTED_EVIDENCE_CHARS) {
      throw new Error(
        `Read rejected: retaining this batch would exceed the inspected ` +
          `evidence limit of ${String(MAX_INSPECTED_EVIDENCE_CHARS)} characters. ` +
          "No source from this read was retained.",
      );
    }

    const explicitCandidateIds = new Set(inspectedCandidateIds);
    const explicitlyInspectedMemoryIds = new Set(
      inspectedCandidateIds
        .map((candidateId) => this.candidatesById.get(candidateId)?.memoryId)
        .filter((memoryId): memoryId is string => memoryId !== undefined),
    );
    for (const evidence of evidenceRecords) {
      const needsExpansionCandidate = explicitCandidateIds.size > 0
        ? !explicitlyInspectedMemoryIds.has(evidence.memoryId)
        : !this.candidateIdsByMemoryId.has(evidence.memoryId);
      if (needsExpansionCandidate) {
        this.upsertCandidate(evidence.memoryId, evidence, compactPreview(evidence.content), {
          step,
          tool: "read_expansion",
        });
      }
      if (!this.evidenceRefById.has(evidence.memoryId)) {
        const evidenceRef = `E${String(this.evidenceRefById.size + 1)}`;
        this.evidenceRefById.set(evidence.memoryId, evidenceRef);
      }
    }
    this.evidenceById = nextEvidenceById;
    const inspectedMemoryIds = new Set(
      evidenceRecords.map((evidence) => evidence.memoryId),
    );
    for (const candidate of this.candidatesById.values()) {
      if (!inspectedMemoryIds.has(candidate.memoryId)) continue;
      if (
        explicitCandidateIds.size === 0 ||
        explicitCandidateIds.has(candidate.candidateId) ||
        candidate.discoveries.some((item) => item.tool === "read_expansion")
      ) {
        candidate.inspected = true;
      }
    }
    this.assertInvariants();
    return evidenceRecords.map(cloneEvidence);
  }

  recordBashDiscoveries(
    records: readonly MemoryRecord[],
    command: string,
    step = this.nextStep(),
  ): MemoryCandidate[] {
    for (const record of records) this.assertScope(record);
    for (const record of records) {
      this.upsertCandidate(record.memoryId, record, compactPreview(record.content), {
        step,
        tool: "bash_ro",
        query: command,
        retriever: "bash_ro",
      });
    }
    this.assertInvariants();
    return this.selectCandidates(records.map((record) => record.memoryId));
  }

  finish(input: PicorerSelection): PicorerSelection {
    const evidenceSummary = input.evidenceSummary?.trim();
    if (input.status === "sufficient" && input.citations.length === 0) {
      throw new Error("A sufficient selection must cite at least one memory");
    }
    if (evidenceSummary !== undefined && !evidenceSummary) {
      throw new Error("evidenceSummary must not be empty");
    }
    const seenCitationIds = new Set<string>();
    const citations = input.citations.map((citation) => {
      const memoryId = citation.memoryId.trim();
      const supports = citation.supports.trim();
      if (!memoryId) {
        throw new Error("Citation memoryId must not be empty");
      }
      if (!supports) {
        throw new Error(`Citation supports must not be empty: ${memoryId}`);
      }
      if (!this.evidenceById.has(memoryId)) {
        throw new Error(
          `Finish rejected: citation must reference memory inspected in this run: ` +
            `${memoryId}. Do not repeat this call; call read for that memory ` +
            `before citing it, or remove the citation.`,
        );
      }
      if (seenCitationIds.has(memoryId)) {
        throw new Error(`Duplicate citation memory: ${memoryId}`);
      }
      seenCitationIds.add(memoryId);
      return { memoryId, supports };
    });
    if (
      seenCitationIds.size !== this.evidenceById.size ||
      [...this.evidenceById.keys()].some((memoryId) => !seenCitationIds.has(memoryId))
    ) {
      throw new Error(
        "Finish must commit every exact source returned by read",
      );
    }
    const inventory = input.inventory?.map((entry) => {
      const item = entry.item.trim();
      const memoryIds = [
        ...new Set(entry.memoryIds.map((memoryId) => memoryId.trim())),
      ].filter(Boolean);
      if (!item) throw new Error("Inventory item must not be empty");
      if (memoryIds.length === 0) {
        throw new Error(`Inventory item must cite inspected memory: ${item}`);
      }
      for (const memoryId of memoryIds) {
        if (!this.evidenceById.has(memoryId)) {
          throw new Error(
            `Inventory item must reference memory inspected in this run: ${memoryId}`,
          );
        }
      }
      return { item, memoryIds };
    });
    if (
      input.count !== undefined &&
      (!Number.isSafeInteger(input.count) || input.count < 0)
    ) {
      throw new Error("Evidence count must be a non-negative integer");
    }

    const selection: PicorerSelection = {
      status: input.status,
      citations,
      ...(evidenceSummary === undefined ? {} : { evidenceSummary }),
      ...(input.count === undefined ? {} : { count: input.count }),
      ...(inventory === undefined ? {} : { inventory }),
    };
    if (this.acceptedSelection) {
      if (JSON.stringify(this.acceptedSelection) === JSON.stringify(selection)) {
        return cloneSelection(this.acceptedSelection);
      }
      throw new Error("A different evidence selection has already been accepted for this run");
    }

    for (const citation of citations) {
      const candidates = this.selectMemoryCandidates([citation.memoryId])
        .filter((candidate) => candidate.inspected);
      if (candidates.length === 0) {
        throw new Error(
          `Internal ledger error: committed evidence is not an inspected candidate: ${citation.memoryId}`,
        );
      }
      for (const candidate of candidates) {
        this.candidatesById.get(candidate.candidateId)!.committed = true;
      }
    }

    this.acceptedSelection = selection;
    this.assertInvariants();
    return cloneSelection(selection);
  }

  assertInvariants(): void {
    for (const [memoryId] of this.evidenceById) {
      const candidates = this.selectMemoryCandidates([memoryId]);
      if (!candidates.some((candidate) => candidate.inspected)) {
        throw new Error(
          `Ledger invariant violated: evidence is not an inspected candidate: ${memoryId}`,
        );
      }
    }

    for (const citation of this.acceptedSelection?.citations ?? []) {
      const candidates = this.selectMemoryCandidates([citation.memoryId]);
      if (!this.evidenceById.has(citation.memoryId)) {
        throw new Error(
          `Ledger invariant violated: citation is not evidence: ${citation.memoryId}`,
        );
      }
      if (!candidates.some((candidate) => candidate.committed)) {
        throw new Error(
          `Ledger invariant violated: citation is not marked committed: ${citation.memoryId}`,
        );
      }
    }
  }

  private assertScope(record: Pick<MemoryRecord, "scopeId" | "memoryId">): void {
    if (record.scopeId !== this.scopeId) {
      throw new Error(
        `Memory belongs to scope ${record.scopeId}, expected ${this.scopeId}: ${record.memoryId}`,
      );
    }
  }

  private upsertCandidate(
    candidateId: string,
    record: Pick<
      MemoryRecord,
      "memoryId" | "scopeId" | "sessionId" | "turnIndex" | "role" | "timestamp"
    >,
    preview: string,
    discovery: MemoryCandidate["discoveries"][number],
    passage?: MemoryPassage,
  ): void {
    const existing = this.candidatesById.get(candidateId);
    if (existing) {
      const previousBestSearchRank = existing.discoveries.reduce<number | undefined>(
        (best, item) => {
          if (item.tool !== "search" || item.rank === undefined) return best;
          return best === undefined ? item.rank : Math.min(best, item.rank);
        },
        undefined,
      );
      const discoveryKey = JSON.stringify(discovery);
      const alreadyRecorded = existing.discoveries.some(
        (item) => JSON.stringify(item) === discoveryKey,
      );
      if (!alreadyRecorded) existing.discoveries.push({ ...discovery });
      if (
        discovery.tool === "search" &&
        discovery.rank !== undefined &&
        (previousBestSearchRank === undefined ||
          discovery.rank <= previousBestSearchRank)
      ) {
        existing.preview = preview;
      }
      return;
    }

    const candidate: MemoryCandidate = {
      candidateId,
      memoryId: record.memoryId,
      scopeId: record.scopeId,
      sessionId: record.sessionId,
      turnIndex: record.turnIndex,
      role: record.role,
      preview,
      discoveries: [{ ...discovery }],
      inspected: false,
      committed: false,
      ...(passage === undefined ? {} : { passage: { ...passage } }),
    };
    if (record.timestamp !== undefined) {
      candidate.timestamp = record.timestamp;
    }
    this.candidatesById.set(candidateId, candidate);
    const candidatesForMemory = this.candidateIdsByMemoryId.get(record.memoryId) ??
      new Set<string>();
    candidatesForMemory.add(candidateId);
    this.candidateIdsByMemoryId.set(record.memoryId, candidatesForMemory);
    const candidateRef = `C${String(this.candidateIdByRef.size + 1)}`;
    this.candidateRefById.set(candidateId, candidateRef);
    this.candidateIdByRef.set(candidateRef, candidateId);
  }
}
