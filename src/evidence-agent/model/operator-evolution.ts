import type { SearchOperatorDefinition } from "../../retrieval/index.js";
import { sha256 } from "../../util.js";
import type { PicorerResult, ToolTraceEntry } from "./evidence.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface OperatorEvolutionOptions {
  /** Total custom definitions available to one retrieval run. */
  capacity?: number;
  /** Slots deliberately left empty so the next run can define new plans. */
  explorationSlots?: number;
  /** Distinct evidence-contributing questions required for promotion. */
  promotionQuestions?: number;
}

export type OperatorEvolutionPhase = "provisional" | "promoted";

export interface OperatorEvolutionEntrySnapshot {
  definitionHash: string;
  definition: SearchOperatorDefinition;
  phase: OperatorEvolutionPhase;
  firstSeenSequence: number;
  lastSeenSequence: number;
  executedQuestionIds: string[];
  successfulQuestionIds: string[];
  executions: number;
  citedMemoryIds: string[];
}

export interface OperatorEvolutionSnapshot {
  schemaVersion: 1;
  capacity: number;
  explorationSlots: number;
  promotionQuestions: number;
  sequence: number;
  seenQuestionIds: string[];
  entries: OperatorEvolutionEntrySnapshot[];
}

export interface OperatorEvolutionDecision {
  operatorId: string;
  definitionHash: string;
  action: "admitted" | "credited" | "observed" | "rejected";
  reason:
    | "evidence-contributing"
    | "insufficient-result"
    | "no-cited-candidate"
    | "not-executed"
    | "query-bound-definition";
  citedMemoryIds: string[];
}

export interface OperatorEvolutionObservation {
  questionId: string;
  selectedBefore: string[];
  selectedAfter: string[];
  decisions: OperatorEvolutionDecision[];
}

interface SearchUse {
  definitionHash?: string;
  operatorId: string;
  candidateMemoryIds: string[];
  countsAsExecution: boolean;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return normalized;
}

function definitionHash(definition: SearchOperatorDefinition): string {
  return sha256(JSON.stringify(definition));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function searchUse(trace: ToolTraceEntry): SearchUse | undefined {
  if (
    (trace.toolName !== "search" && trace.toolName !== "search_more") ||
    !isRecord(trace.details)
  ) return undefined;
  const operatorId = trace.details.operator;
  if (typeof operatorId !== "string") return undefined;
  const composition = trace.details.composition;
  const hash = isRecord(composition) && typeof composition.definitionHash === "string"
    ? composition.definitionHash
    : undefined;
  const references = [
    ...(Array.isArray(trace.details.candidateReferences)
      ? trace.details.candidateReferences
      : []),
    ...(Array.isArray(trace.details.directoryCandidateReferences)
      ? trace.details.directoryCandidateReferences
      : []),
  ];
  const candidateMemoryIds = references.flatMap((reference) =>
    isRecord(reference) && typeof reference.memoryId === "string"
      ? [reference.memoryId]
      : []
  );
  return {
    operatorId,
    ...(hash === undefined ? {} : { definitionHash: hash }),
    candidateMemoryIds: [...new Set(candidateMemoryIds)],
    // search_more reveals another page from the same immutable physical
    // execution. Its candidates contribute evidence, but it must not inflate
    // the operator's execution count.
    countsAsExecution: trace.toolName === "search",
  };
}

function isQueryAgnostic(definition: SearchOperatorDefinition): boolean {
  return definition.steps.every((step) =>
    step.kind !== "search" || step.queries === undefined
  );
}

function cloneEntry(entry: OperatorEvolutionEntrySnapshot): OperatorEvolutionEntrySnapshot {
  return {
    ...entry,
    definition: structuredClone(entry.definition),
    executedQuestionIds: [...entry.executedQuestionIds],
    successfulQuestionIds: [...entry.successfulQuestionIds],
    citedMemoryIds: [...entry.citedMemoryIds],
  };
}

function normalizedQuestionId(questionId: string): string {
  const normalized = questionId.trim();
  if (!normalized) throw new Error("Evolution question ID must not be empty");
  return normalized;
}

/**
 * Carries reusable declarative retrieval plans across an incremental question
 * stream. Admission depends only on a plan's observable contribution to cited
 * retrieval evidence; no downstream scoring input crosses this boundary.
 */
export class OperatorEvolutionCatalog {
  readonly capacity: number;
  readonly explorationSlots: number;
  readonly promotionQuestions: number;

  private sequence = 0;
  private readonly seenQuestionIds = new Set<string>();
  private readonly entries = new Map<string, OperatorEvolutionEntrySnapshot>();

  constructor(options: OperatorEvolutionOptions = {}) {
    this.capacity = integerOption(options.capacity, 4, "Evolution capacity", 1, 8);
    this.explorationSlots = integerOption(
      options.explorationSlots,
      1,
      "Evolution exploration slots",
      0,
      this.capacity - 1,
    );
    this.promotionQuestions = integerOption(
      options.promotionQuestions,
      2,
      "Evolution promotion questions",
      2,
      100,
    );
  }

  static restore(snapshot: OperatorEvolutionSnapshot): OperatorEvolutionCatalog {
    if (snapshot.schemaVersion !== 1) {
      throw new Error(`Unsupported operator evolution schema ${String(snapshot.schemaVersion)}`);
    }
    const catalog = new OperatorEvolutionCatalog({
      capacity: snapshot.capacity,
      explorationSlots: snapshot.explorationSlots,
      promotionQuestions: snapshot.promotionQuestions,
    });
    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new Error("Operator evolution sequence must be a non-negative integer");
    }
    catalog.sequence = snapshot.sequence;
    for (const questionId of snapshot.seenQuestionIds) {
      const normalized = normalizedQuestionId(questionId);
      if (catalog.seenQuestionIds.has(normalized)) {
        throw new Error(`Duplicate evolution question ID ${normalized}`);
      }
      catalog.seenQuestionIds.add(normalized);
    }
    for (const source of snapshot.entries) {
      if (!SHA256.test(source.definitionHash)) {
        throw new Error(`Invalid operator definition hash ${source.definitionHash}`);
      }
      if (definitionHash(source.definition) !== source.definitionHash) {
        throw new Error(`Operator definition hash mismatch for ${source.definition.id}`);
      }
      if (!isQueryAgnostic(source.definition)) {
        throw new Error(`Persisted operator ${source.definition.id} contains fixed queries`);
      }
      if (catalog.entries.has(source.definitionHash)) {
        throw new Error(`Duplicate operator evolution entry ${source.definitionHash}`);
      }
      catalog.entries.set(source.definitionHash, cloneEntry(source));
    }
    return catalog;
  }

  maxDefinitionsForRun(): number {
    return this.capacity;
  }

  definitionsForNextQuestion(): SearchOperatorDefinition[] {
    const limit = this.capacity - this.explorationSlots;
    const selected: OperatorEvolutionEntrySnapshot[] = [];
    const selectedIds = new Set<string>();
    const ranked = [...this.entries.values()].sort((left, right) => {
      const leftRate = left.successfulQuestionIds.length /
        Math.max(1, left.executedQuestionIds.length);
      const rightRate = right.successfulQuestionIds.length /
        Math.max(1, right.executedQuestionIds.length);
      return rightRate - leftRate ||
        right.successfulQuestionIds.length - left.successfulQuestionIds.length ||
        right.citedMemoryIds.length - left.citedMemoryIds.length ||
        right.lastSeenSequence - left.lastSeenSequence ||
        left.definitionHash.localeCompare(right.definitionHash);
    });
    for (const entry of ranked) {
      if (selectedIds.has(entry.definition.id)) continue;
      selected.push(entry);
      selectedIds.add(entry.definition.id);
      if (selected.length === limit) break;
    }
    return selected.map((entry) => structuredClone(entry.definition));
  }

  observe(questionId: string, result: PicorerResult): OperatorEvolutionObservation {
    const normalizedId = normalizedQuestionId(questionId);
    if (this.seenQuestionIds.has(normalizedId)) {
      throw new Error(`Evolution question ${normalizedId} was already observed`);
    }
    const selectedBefore = this.definitionsForNextQuestion().map((item) =>
      definitionHash(item)
    );
    this.seenQuestionIds.add(normalizedId);
    this.sequence += 1;
    const cited = new Set(result.citations.map((citation) => citation.memoryId));
    const uses = result.trace.flatMap((item) => {
      const use = searchUse(item);
      return use === undefined ? [] : [use];
    });
    const decisions: OperatorEvolutionDecision[] = [];

    for (const snapshot of result.operatorDefinitions) {
      if (definitionHash(snapshot.definition) !== snapshot.definitionHash) {
        throw new Error(`Result operator hash mismatch for ${snapshot.definition.id}`);
      }
      const matchingUses = uses.filter((use) =>
        use.operatorId === snapshot.definition.id &&
        use.definitionHash === snapshot.definitionHash
      );
      const executionCount = matchingUses.filter((use) =>
        use.countsAsExecution
      ).length;
      const citedMemoryIds = [...new Set(
        matchingUses.flatMap((use) => use.candidateMemoryIds).filter((memoryId) =>
          cited.has(memoryId)
        ),
      )].sort();
      const existing = this.entries.get(snapshot.definitionHash);
      const reject = (
        reason: OperatorEvolutionDecision["reason"],
      ): void => {
        decisions.push({
          operatorId: snapshot.definition.id,
          definitionHash: snapshot.definitionHash,
          action: "rejected",
          reason,
          citedMemoryIds,
        });
      };
      if (!isQueryAgnostic(snapshot.definition)) {
        reject("query-bound-definition");
        continue;
      }
      if (matchingUses.length === 0) {
        reject("not-executed");
        continue;
      }

      if (existing !== undefined) {
        existing.executions += executionCount;
        if (!existing.executedQuestionIds.includes(normalizedId)) {
          existing.executedQuestionIds.push(normalizedId);
        }
        existing.lastSeenSequence = this.sequence;
      }
      if (result.status !== "sufficient") {
        if (existing === undefined) reject("insufficient-result");
        else {
          decisions.push({
            operatorId: snapshot.definition.id,
            definitionHash: snapshot.definitionHash,
            action: "observed",
            reason: "insufficient-result",
            citedMemoryIds,
          });
        }
        continue;
      }
      if (citedMemoryIds.length === 0) {
        if (existing === undefined) reject("no-cited-candidate");
        else {
          decisions.push({
            operatorId: snapshot.definition.id,
            definitionHash: snapshot.definitionHash,
            action: "observed",
            reason: "no-cited-candidate",
            citedMemoryIds,
          });
        }
        continue;
      }

      const entry = existing ?? {
        definitionHash: snapshot.definitionHash,
        definition: structuredClone(snapshot.definition),
        phase: "provisional" as const,
        firstSeenSequence: this.sequence,
        lastSeenSequence: this.sequence,
        executedQuestionIds: [normalizedId],
        successfulQuestionIds: [],
        executions: executionCount,
        citedMemoryIds: [],
      };
      if (!entry.successfulQuestionIds.includes(normalizedId)) {
        entry.successfulQuestionIds.push(normalizedId);
      }
      entry.citedMemoryIds = [...new Set([
        ...entry.citedMemoryIds,
        ...citedMemoryIds,
      ])].sort();
      entry.phase = entry.successfulQuestionIds.length >= this.promotionQuestions
        ? "promoted"
        : "provisional";
      this.entries.set(snapshot.definitionHash, entry);
      decisions.push({
        operatorId: snapshot.definition.id,
        definitionHash: snapshot.definitionHash,
        action: existing === undefined ? "admitted" : "credited",
        reason: "evidence-contributing",
        citedMemoryIds,
      });
    }

    return {
      questionId: normalizedId,
      selectedBefore,
      selectedAfter: this.definitionsForNextQuestion().map((item) =>
        definitionHash(item)
      ),
      decisions,
    };
  }

  snapshot(): OperatorEvolutionSnapshot {
    return {
      schemaVersion: 1,
      capacity: this.capacity,
      explorationSlots: this.explorationSlots,
      promotionQuestions: this.promotionQuestions,
      sequence: this.sequence,
      seenQuestionIds: [...this.seenQuestionIds],
      entries: [...this.entries.values()]
        .sort((left, right) => left.definitionHash.localeCompare(right.definitionHash))
        .map(cloneEntry),
    };
  }
}
