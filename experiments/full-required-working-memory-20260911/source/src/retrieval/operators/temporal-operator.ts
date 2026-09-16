import type { RetrievalHit } from "../model/search.js";
import { calendarTimestamp, compareMemoryChronology, sourceCalendarTimestamp } from "../model/source-time.js";
import type {
  EvidenceOperatorResult,
  EvidenceOperatorRow,
  SearchRequest,
} from "../model/search.js";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export interface ResolvedTemporalTarget {
  expression: string;
  date: string;
  basis: "relative-to-question" | "explicit-in-question";
}

export interface TemporalQuestionPlan {
  questionDate?: string;
  targets: ResolvedTemporalTarget[];
}

export interface TemporalFact {
  expression: string;
  resolvedDate: string;
  basis: "explicit-in-memory" | "relative-to-memory";
  index: number;
  end: number;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return date.setUTCHours(0, 0, 0, 0);
}

function addCalendarUnits(
  timestamp: number,
  amount: number,
  unit: "day" | "week" | "month" | "year",
): number {
  const date = new Date(startOfDay(timestamp));
  if (unit === "day") date.setUTCDate(date.getUTCDate() + amount);
  if (unit === "week") date.setUTCDate(date.getUTCDate() + amount * 7);
  if (unit === "month" || unit === "year") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (unit === "month") date.setUTCMonth(date.getUTCMonth() + amount);
    else date.setUTCFullYear(date.getUTCFullYear() + amount);
    const end = new Date(date.getTime());
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, end.getUTCDate()));
  }
  return date.getTime();
}

function cleanQuestion(question: string): string {
  return question
    .replace(
      /^\s*now is\s+\d{4}[/-]\d{2}[/-]\d{2}(?:\s*\([^)]*\))?(?:\s+\d{2}:\d{2})?\.?\s*(?:please answer the question:\s*)?/iu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function parseAmount(value: string): number | undefined {
  if (/^\d+$/u.test(value)) {
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount <= 100_000 ? amount : undefined;
  }
  return NUMBER_WORDS[value.toLowerCase()];
}

export function resolveTemporalQuestion(
  question: string,
  questionDate?: string,
): TemporalQuestionPlan {
  const cleaned = cleanQuestion(question);
  const questionTimestamp = sourceCalendarTimestamp(questionDate);
  const targets: ResolvedTemporalTarget[] = extractTemporalFacts(cleaned, questionDate).map((fact) => ({
    expression: fact.expression,
    date: fact.resolvedDate,
    basis: fact.basis === "explicit-in-memory" ? "explicit-in-question" : "relative-to-question",
  }));
  if (questionTimestamp !== undefined && /\bvalentine(?:'s|s)?\s+day\b/iu.test(cleaned)) {
    targets.push({ expression: "Valentine's Day",
      date: `${String(new Date(questionTimestamp).getUTCFullYear())}-02-14`,
      basis: "explicit-in-question" });
  }
  return { ...(questionDate === undefined ? {} : { questionDate }), targets };
}

function relativeDate(timestamp: number, amount: number, unit: "day" | "week" | "month" | "year"): string | undefined {
  const shifted = addCalendarUnits(timestamp, amount, unit);
  const year = new Date(shifted).getUTCFullYear();
  return Number.isFinite(shifted) && year >= 0 && year <= 9999 ? isoDate(shifted) : undefined;
}

export function temporalAuxiliaryRequest(
  request: SearchRequest,
  plan: TemporalQuestionPlan,
): SearchRequest | undefined {
  if (plan.targets.length !== 1) return undefined;
  const target = plan.targets[0]!;
  const targetPrefix = `${target.date}T`;
  if (
    request.after?.startsWith(targetPrefix) &&
    request.before?.startsWith(targetPrefix)
  ) {
    return undefined;
  }
  return {
    ...request,
    after: request.after ?? `${target.date}T00:00:00`,
    before: request.before ?? `${target.date}T23:59:59.999`,
    order: "chronological",
  };
}

/**
 * Extracts deterministic event-date facts from one immutable memory turn.
 * Relative expressions are anchored only to that turn's source timestamp;
 * no model inference is involved.
 */
export function extractTemporalFacts(
  content: string,
  sourceTimestamp?: string,
): TemporalFact[] {
  const sourceTime = sourceCalendarTimestamp(sourceTimestamp);
  const fallbackYear = sourceTime === undefined
    ? undefined
    : new Date(sourceTime).getUTCFullYear();
  const facts: TemporalFact[] = [];
  const seen = new Set<string>();
  const add = (fact: TemporalFact): void => {
    const key = `${fact.index}\0${fact.end}\0${fact.resolvedDate}`;
    if (!seen.has(key)) {
      seen.add(key);
      facts.push(fact);
    }
  };

  for (const match of content.matchAll(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/gu)) {
    const timestamp = calendarTimestamp(Number(match[1]), Number(match[2]), Number(match[3]));
    if (timestamp === undefined) continue;
    const index = match.index ?? 0;
    add({
      expression: match[0],
      resolvedDate: isoDate(timestamp),
      basis: "explicit-in-memory",
      index,
      end: index + match[0].length,
    });
  }

  const monthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/giu;
  for (const match of content.matchAll(monthPattern)) {
    const month = MONTHS[match[1]!.toLowerCase()];
    const year = Number(match[3] ?? fallbackYear);
    const day = Number(match[2]);
    if (month === undefined || !Number.isFinite(year)) continue;
    const timestamp = calendarTimestamp(year, month + 1, day);
    if (timestamp === undefined) continue;
    const index = match.index ?? 0;
    add({
      expression: match[0],
      resolvedDate: isoDate(timestamp),
      basis: "explicit-in-memory",
      index,
      end: index + match[0].length,
    });
  }

  if (sourceTime !== undefined) {
    const relativePattern = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\s+ago\b/giu;
    for (const match of content.matchAll(relativePattern)) {
      const amount = parseAmount(match[1]!);
      if (amount === undefined) continue;
      const resolvedDate = relativeDate(sourceTime, -amount, match[2]!.toLowerCase() as "day" | "week" | "month" | "year");
      if (resolvedDate === undefined) continue;
      const index = match.index ?? 0;
      add({
        expression: match[0],
        resolvedDate,
        basis: "relative-to-memory",
        index,
        end: index + match[0].length,
      });
    }
    for (const match of content.matchAll(/\byesterday\b/giu)) {
      const resolvedDate = relativeDate(sourceTime, -1, "day");
      if (resolvedDate === undefined) continue;
      const index = match.index ?? 0;
      add({
        expression: match[0],
        resolvedDate,
        basis: "relative-to-memory",
        index,
        end: index + match[0].length,
      });
    }
    for (const match of content.matchAll(/\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/giu)) {
      const targetWeekday = WEEKDAYS[match[1]!.toLowerCase()];
      if (targetWeekday === undefined) continue;
      const sourceWeekday = new Date(sourceTime).getUTCDay();
      const daysBack = ((sourceWeekday - targetWeekday + 7) % 7) || 7;
      const resolvedDate = relativeDate(sourceTime, -daysBack, "day");
      if (resolvedDate === undefined) continue;
      const index = match.index ?? 0;
      add({
        expression: match[0],
        resolvedDate,
        basis: "relative-to-memory",
        index,
        end: index + match[0].length,
      });
    }
  }

  return facts.sort((left, right) =>
    left.index - right.index || left.resolvedDate.localeCompare(right.resolvedDate)
  );
}

export function buildTimelineOperatorResult(
  hits: readonly RetrievalHit[],
  question: string,
  questionDate?: string,
  auxiliaryRequest?: SearchRequest,
): EvidenceOperatorResult {
  const plan = resolveTemporalQuestion(question, questionDate);
  const rows = [...hits].sort((left, right) => compareMemoryChronology(left.record, right.record)).map((hit) => {
    const sessionTimestamp = sourceCalendarTimestamp(hit.record.timestamp);
    const sessionDate = sessionTimestamp === undefined ? undefined : isoDate(sessionTimestamp);
    const mentions = [
      ...new Set([
        ...extractTemporalFacts(hit.record.content, hit.record.timestamp).map((fact) => fact.resolvedDate),
        ...(hit.operatorTemporalFacts ?? []).map((fact) => fact.resolvedDate),
      ]),
    ].sort();
    return {
      slot: hit.query,
      quote: hit.preview,
      memoryId: hit.record.memoryId,
      sessionId: hit.record.sessionId,
      turnIndex: hit.record.turnIndex,
      role: hit.record.role,
      ...(sessionDate === undefined ? {} : { eventTime: sessionDate }),
      ...(mentions.length === 0 ? {} : { mentionedDates: mentions }),
    } satisfies EvidenceOperatorRow;
  });
  return {
    version: "picorer-evidence-operators-v1",
    operator: "temporal",
    rows,
    coverage: {
      candidateCount: hits.length,
      distinctSessions: new Set(hits.map((hit) => hit.record.sessionId)).size,
      truncated: false,
    },
    temporalPlan: {
      ...plan,
      auxiliaryWindowApplied: auxiliaryRequest !== undefined,
    },
  };
}
