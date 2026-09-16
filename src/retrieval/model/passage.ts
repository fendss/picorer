import type { MemoryRecord } from "../../memory/index.js";
import { sha256 } from "../../util.js";
import { tokenizeForPicorerHybrid } from "../ranking.js";
import type { RetrievalHit } from "./search.js";

export const PASSAGE_VIEW_VERSION = "picorer-passage-v1";
export const TARGET_PASSAGE_CHARS = 1_200;
export const MAX_PASSAGE_CHARS = 1_600;
export const MAX_PASSAGE_OVERLAP_CHARS = 240;
export const MAX_PASSAGES_PER_PARENT_HIT = 2;

/** An exact, source-bound view over one immutable parent memory. */
export interface MemoryPassage {
  passageId: string;
  parentMemoryId: string;
  sourceContentHash: string;
  index: number;
  start: number;
  end: number;
  content: string;
}

interface Span {
  start: number;
  end: number;
}

function passageId(
  record: Pick<MemoryRecord, "memoryId" | "contentHash">,
  start: number,
  end: number,
): string {
  return `P-${sha256(JSON.stringify([
    PASSAGE_VIEW_VERSION,
    record.memoryId,
    record.contentHash,
    start,
    end,
  ])).slice(0, 24)}`;
}

function splitLongSpan(content: string, span: Span): Span[] {
  const output: Span[] = [];
  let start = span.start;
  while (span.end - start > MAX_PASSAGE_CHARS) {
    const hardEnd = start + MAX_PASSAGE_CHARS;
    const searchStart = start + Math.floor(MAX_PASSAGE_CHARS * 0.65);
    const window = content.slice(searchStart, hardEnd);
    const relativeBreak = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
      window.lastIndexOf("\t"),
    );
    const end = relativeBreak < 0 ? hardEnd : searchStart + relativeBreak + 1;
    output.push({ start, end });
    start = end;
  }
  if (start < span.end || output.length === 0) output.push({ start, end: span.end });
  return output;
}

/**
 * Finds deterministic sentence/paragraph boundaries while preserving UTF-16
 * offsets into the exact source. Long unpunctuated spans fall back to a nearby
 * whitespace boundary so no passage can grow without bound.
 */
function sentenceSpans(content: string): Span[] {
  if (content.length === 0) return [{ start: 0, end: 0 }];
  const boundaries = /[.!?]+["'”’)}\]]*(?:\s+|$)|[。！？]+["'”’)}\]]*\s*|\n{2,}/gu;
  const spans: Span[] = [];
  let start = 0;
  for (const match of content.matchAll(boundaries)) {
    const index = match.index;
    if (index === undefined) continue;
    const end = index + match[0].length;
    if (end > start) spans.push({ start, end });
    start = end;
  }
  if (start < content.length) spans.push({ start, end: content.length });
  return spans.flatMap((span) => splitLongSpan(content, span));
}

/** Builds a small, deterministic passage view without mutating parent memory. */
export function memoryPassages(record: MemoryRecord): MemoryPassage[] {
  const sentences = sentenceSpans(record.content);
  const spans: Span[] = [];
  let cursor = 0;
  while (cursor < sentences.length) {
    const startIndex = cursor;
    const start = sentences[startIndex]!.start;
    let endIndex = startIndex;
    let end = sentences[endIndex]!.end;
    while (
      endIndex + 1 < sentences.length &&
      sentences[endIndex + 1]!.end - start <= MAX_PASSAGE_CHARS &&
      end - start < TARGET_PASSAGE_CHARS
    ) {
      endIndex += 1;
      end = sentences[endIndex]!.end;
    }
    spans.push({ start, end });

    const lastSentence = sentences[endIndex]!;
    const canOverlap = endIndex + 1 < sentences.length &&
      endIndex > startIndex &&
      lastSentence.end - lastSentence.start <= MAX_PASSAGE_OVERLAP_CHARS;
    cursor = canOverlap ? endIndex : endIndex + 1;
  }

  return spans.map((span, index) => ({
    passageId: passageId(record, span.start, span.end),
    parentMemoryId: record.memoryId,
    sourceContentHash: record.contentHash,
    index,
    start: span.start,
    end: span.end,
    content: record.content.slice(span.start, span.end),
  }));
}

function normalizedSourceText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Larger means the exact passage is a better home for an operator quote. */
export function sourceQuoteMatchScore(content: string, quote: string): number {
  const normalizedContent = normalizedSourceText(content);
  const normalizedQuote = normalizedSourceText(quote);
  if (!normalizedQuote) return 0;
  if (normalizedContent.includes(normalizedQuote)) {
    return 1_000_000 + normalizedQuote.length;
  }
  const fragments = normalizedQuote
    .split(/(?:\.{3}|…|\[. source content omitted.*?\])/gu)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 12);
  return fragments.reduce(
    (best, fragment) => normalizedContent.includes(fragment)
      ? Math.max(best, fragment.length)
      : best,
    0,
  );
}

function passageScore(passage: MemoryPassage, query: string): number {
  const normalized = passage.content.normalize("NFKC").toLowerCase();
  const phrase = query.normalize("NFKC").toLowerCase().trim();
  const terms = [...new Set(tokenizeForPicorerHybrid(query))]
    .filter((term) => term.length > 1);
  let score = terms.length > 0 && phrase.length > 1 && normalized.includes(phrase)
    ? 100
    : 0;
  const passageTerms = tokenizeForPicorerHybrid(passage.content);
  const frequencies = new Map<string, number>();
  for (const term of passageTerms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  for (const term of terms) {
    const occurrences = Math.min(frequencies.get(term) ?? 0, 4);
    for (let index = 0; index < occurrences; index += 1) {
      score += Math.min(term.length, 16);
    }
  }
  return score;
}

function sourceSpanMatchScore(
  passage: MemoryPassage,
  span: { start: number; end: number },
): number {
  if (passage.start <= span.start && passage.end >= span.end) {
    return 2_000_000 + span.end - span.start;
  }
  const overlap = Math.max(
    0,
    Math.min(passage.end, span.end) - Math.max(passage.start, span.start),
  );
  return overlap;
}

export function rankMemoryPassages(
  record: MemoryRecord,
  queries: readonly string[],
  sourceQuotes: readonly string[] = [],
  sourceSpans: readonly { start: number; end: number }[] = [],
): MemoryPassage[] {
  const passages = memoryPassages(record);
  return passages.sort((left, right) => {
    const leftSpanScore = sourceSpans.reduce(
      (best, span) => Math.max(best, sourceSpanMatchScore(left, span)),
      0,
    );
    const rightSpanScore = sourceSpans.reduce(
      (best, span) => Math.max(best, sourceSpanMatchScore(right, span)),
      0,
    );
    if (leftSpanScore !== rightSpanScore) return rightSpanScore - leftSpanScore;
    const leftQuoteScore = sourceQuotes.reduce(
      (best, quote) => Math.max(best, sourceQuoteMatchScore(left.content, quote)),
      0,
    );
    const rightQuoteScore = sourceQuotes.reduce(
      (best, quote) => Math.max(best, sourceQuoteMatchScore(right.content, quote)),
      0,
    );
    if (leftQuoteScore !== rightQuoteScore) return rightQuoteScore - leftQuoteScore;
    const leftScore = queries.reduce(
      (best, query) => Math.max(best, passageScore(left, query)),
      0,
    );
    const rightScore = queries.reduce(
      (best, query) => Math.max(best, passageScore(right, query)),
      0,
    );
    return rightScore - leftScore || left.index - right.index;
  });
}

export function retrievalHitIdentity(hit: RetrievalHit): string {
  return hit.passage?.passageId ?? hit.record.memoryId;
}

/**
 * Converts parent-level operator output into exact passage candidates. Parent
 * breadth is retained first; a second passage is admitted only with remaining
 * result capacity.
 */
export function projectSearchHitsToPassages(
  hits: readonly RetrievalHit[],
  limit: number,
  sourceQuotesByMemoryId: ReadonlyMap<string, readonly string[]> = new Map(),
  maxPerSession?: number,
): RetrievalHit[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const primaries: RetrievalHit[] = [];
  const secondary: RetrievalHit[] = [];
  const seenParents = new Set<string>();

  for (const hit of hits) {
    if (seenParents.has(hit.record.memoryId)) continue;
    seenParents.add(hit.record.memoryId);
    const queries = hit.matchedQueries ?? [hit.query];
    const sourceQuotes = sourceQuotesByMemoryId.get(hit.record.memoryId) ?? [];
    const sourceSpans = (hit.operatorSourceSpans ?? []).filter((span) =>
      Number.isSafeInteger(span.start) &&
      Number.isSafeInteger(span.end) &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= hit.record.content.length
    );
    const rankedPassages = rankMemoryPassages(
      hit.record,
      queries,
      sourceQuotes,
      sourceSpans,
    );
    const hasPassageSignal = rankedPassages.some((passage) =>
      sourceSpans.some((span) => sourceSpanMatchScore(passage, span) > 0) ||
      queries.some((query) => passageScore(passage, query) > 0) ||
      sourceQuotes.some((quote) =>
        sourceQuoteMatchScore(passage.content, quote) > 0
      )
    );
    if (!hasPassageSignal) {
      // A semantic parent hit without a passage-local signal stays a legacy
      // parent candidate. Its read path uses the bounded source projector;
      // silently choosing passage zero would manufacture false precision.
      primaries.push(hit);
      continue;
    }
    const passages = rankedPassages
      .slice(0, MAX_PASSAGES_PER_PARENT_HIT);
    passages.forEach((passage, index) => {
      const matchedQueries = queries.filter((query) =>
        passageScore(passage, query) > 0
      );
      const matchesSourceQuote = sourceQuotes.some((quote) =>
        sourceQuoteMatchScore(passage.content, quote) > 0
      );
      const matchesSourceSpan = sourceSpans.some((span) =>
        sourceSpanMatchScore(passage, span) > 0
      );
      if (
        index > 0 &&
        matchedQueries.length === 0 &&
        !matchesSourceQuote &&
        !matchesSourceSpan
      ) return;
      const { matchedQueries: _parentMatchedQueries, ...parentHit } = hit;
      const projected: RetrievalHit = {
        ...parentHit,
        // A zero-signal passage keeps only the winning parent query as a
        // fallback path; it must not inherit every parent-level match.
        query: matchedQueries[0] ?? hit.query,
        ...(matchedQueries.length === 0 ? {} : { matchedQueries }),
        passage,
        preview: passage.content,
      };
      (index === 0 ? primaries : secondary).push(projected);
    });
  }

  // Parent breadth wins: when primaries already fill the requested passage
  // limit, no parent receives a second passage in this call.
  const sessionCounts = new Map<string, number>();
  return [...primaries, ...secondary]
    .filter((hit) => {
      if (maxPerSession === undefined) return true;
      const count = sessionCounts.get(hit.record.sessionId) ?? 0;
      if (count >= maxPerSession) return false;
      sessionCounts.set(hit.record.sessionId, count + 1);
      return true;
    })
    .slice(0, boundedLimit)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}

export function assertPassageMatchesRecord(
  passage: MemoryPassage,
  record: MemoryRecord,
): void {
  if (
    passage.parentMemoryId !== record.memoryId ||
    passage.sourceContentHash !== record.contentHash ||
    passage.passageId !== passageId(record, passage.start, passage.end) ||
    !Number.isSafeInteger(passage.start) ||
    !Number.isSafeInteger(passage.end) ||
    passage.start < 0 ||
    passage.end < passage.start ||
    passage.end > record.content.length ||
    record.content.slice(passage.start, passage.end) !== passage.content
  ) {
    throw new Error(
      `Passage ${passage.passageId} does not match immutable parent ${record.memoryId}`,
    );
  }
}
