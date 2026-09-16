import { compareMemoryChronology, parseSourceTimestamp } from "../model/source-time.js";
import type { RetrievalHit } from "../model/search.js";
import type {
  EvidenceOperatorResult,
  EvidenceOperatorRow,
  NumericValueKind,
} from "../model/search.js";

export interface NumericFact {
  raw: string;
  value: number;
  unit: string;
  index: number;
  end: number;
  valueKind: NumericValueKind;
}

const CURRENCY: Record<string, string> = {
  "$": "USD",
  "£": "GBP",
  "€": "EUR",
};

const DECIMAL = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const NUMBER_BOUNDARY = String.raw`(?<![\p{L}\p{N}_.,+-])`;
const NUMBER_WITH_UNIT = new RegExp(`${NUMBER_BOUNDARY}(${DECIMAL})\\s+(comments?|followers?|bikes?|items?|products?|sales?|visits?|times?|restaurants?|books?|videos?|views?)\\b`, "giu");
const CURRENCY_VALUE = new RegExp(`([+-]?[$£€])\\s*(${DECIMAL})(?!\\d|[,.]\\d)`, "gu");
const VALUE_CURRENCY = new RegExp(`${NUMBER_BOUNDARY}(${DECIMAL})\\s*(dollars?|usd|pounds?|gbp|euros?|eur)\\b`, "giu");

function numericValue(raw: string): number | undefined {
  const value = Number(raw.replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

function extractNumericMentions(content: string): Omit<NumericFact, "valueKind">[] {
  const mentions: Omit<NumericFact, "valueKind">[] = [];
  for (const match of content.matchAll(CURRENCY_VALUE)) {
    // Two signs across the currency symbol are ambiguous, not multiplication.
    if (/^[+-]/u.test(match[1]!) && /^[+-]/u.test(match[2]!)) continue;
    const parsed = numericValue(match[2]!);
    if (parsed === undefined) continue;
    const value = match[1]![0] === "-" ? -parsed : parsed;
    let index = match.index ?? 0;
    let end = index + match[0].length;
    const after = content.slice(index + match[0].length, index + match[0].length + 24);
    const sentenceStart = Math.max(
      content.lastIndexOf(".", index),
      content.lastIndexOf("!", index),
      content.lastIndexOf("?", index),
    );
    const before = content.slice(sentenceStart + 1, index);
    // Only an explicit adjacent quantity/price construction permits arithmetic.
    // A year or unrelated number earlier in the sentence is not a quantity.
    const quantityMatch = /\b(\d[\d,]*)\s+(?:[a-z-]+\s+){1,3}(?:for|at)\s*$/iu.exec(before);
    const quantity = quantityMatch === null ? undefined : numericValue(quantityMatch[1]!);
    const perUnit = /^\s*(?:each|per\s+(?:item|unit|piece|plant|jar|product))\b/iu.exec(after);
    const total = perUnit !== null && quantity !== undefined ? value * quantity : undefined;
    const explicitTotal = total !== undefined && Number.isFinite(total);
    if (explicitTotal) {
      index = sentenceStart + 1 + quantityMatch!.index;
      end += perUnit![0].length;
    }
    mentions.push({
      raw: content.slice(index, end),
      value: explicitTotal ? total! : value,
      unit: CURRENCY[match[1]!.slice(-1)]!,
      index,
      end,
    });
  }
  for (const match of content.matchAll(VALUE_CURRENCY)) {
    const value = numericValue(match[1]!);
    if (value === undefined) continue;
    const rawUnit = match[2]!.toLowerCase();
    const unit = rawUnit.startsWith("dollar") || rawUnit === "usd"
      ? "USD"
      : rawUnit.startsWith("pound") || rawUnit === "gbp"
        ? "GBP"
        : "EUR";
    const index = match.index ?? 0;
    mentions.push({
      raw: match[0],
      value,
      unit,
      index,
      end: index + match[0].length,
    });
  }
  for (const match of content.matchAll(NUMBER_WITH_UNIT)) {
    const value = numericValue(match[1]!);
    if (value === undefined) continue;
    mentions.push({
      raw: match[0],
      value,
      unit: match[2]!.toLowerCase().replace(/s$/u, ""),
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return mentions
    .sort((left, right) => left.index - right.index)
    .filter((mention, index, all) =>
      index === 0 ||
      mention.index !== all[index - 1]!.index ||
      mention.raw !== all[index - 1]!.raw
    );
}

function classifyValue(
  content: string,
  mention: Omit<NumericFact, "valueKind">,
): NumericValueKind {
  let start = 0;
  let end = content.length;
  for (const boundary of content.matchAll(/[.!?;](?=\s|$)|\n/gu)) {
    if (boundary.index < mention.index) start = boundary.index + boundary[0].length;
    else if (boundary.index >= mention.end) { end = boundary.index; break; }
  }
  const context = content.slice(Math.max(start, mention.index - 80), Math.min(end, mention.end + 80)).toLowerCase();
  if (/\b(?:hope|goal|aim|target|budget|plan(?:ning)? to|want to|expect(?:ed)? to|would like to)\b/u.test(context)) {
    return "target";
  }
  if (/\b(?:so far|to date|altogether|cumulative|overall total|total across|current total)\b/u.test(context)) {
    return "cumulative";
  }
  if (/\b(?:currently|right now|now have|current|personal best|record is|followers? (?:is|are|at))\b/u.test(context)) {
    return "snapshot";
  }
  return "increment";
}

export function extractNumericFacts(content: string): NumericFact[] {
  return extractNumericMentions(content).map((mention) => ({
    ...mention,
    valueKind: classifyValue(content, mention),
  }));
}

function rowKey(hit: RetrievalHit, mention: NumericFact): string {
  return `${hit.record.memoryId}|${mention.index}:${mention.end}|${mention.unit}`;
}

export function buildAggregateOperatorResult(
  hits: readonly RetrievalHit[],
): EvidenceOperatorResult {
  const records = new Map(hits.map((hit) => [hit.record.memoryId, hit.record]));
  const compareRows = (left: EvidenceOperatorRow, right: EvidenceOperatorRow): number =>
    compareMemoryChronology(records.get(left.memoryId)!, records.get(right.memoryId)!);
  const rows: EvidenceOperatorRow[] = [];
  for (const hit of hits) {
    const extracted = extractNumericFacts(hit.record.content);
    const selectedIndexes = hit.operatorNumericFactIndexes === undefined
      ? undefined
      : new Set(hit.operatorNumericFactIndexes);
    for (const [factIndex, mention] of extracted.entries()) {
      if (selectedIndexes !== undefined && !selectedIndexes.has(factIndex)) continue;
      rows.push({
        slot: hit.query,
        quote: hit.record.content.slice(
          Math.max(0, mention.index - 90),
          Math.min(hit.record.content.length, mention.index + mention.raw.length + 90),
        ).replace(/\s+/gu, " ").trim(),
        memoryId: hit.record.memoryId,
        sessionId: hit.record.sessionId,
        turnIndex: hit.record.turnIndex,
        role: hit.record.role,
        value: mention.value,
        unit: mention.unit,
        valueKind: mention.valueKind,
        dedupeKey: rowKey(hit, mention),
        rawValue: mention.raw,
        sourceSpan: { start: mention.index, end: mention.end },
        ...(hit.record.timestamp === undefined ? {} : { eventTime: hit.record.timestamp.slice(0, 10) }),
      });
    }
  }
  rows.sort((left, right) => {
    const role = (left.role === "user" ? 0 : 1) - (right.role === "user" ? 0 : 1);
    if (role !== 0) return role;
    return compareRows(left, right);
  });

  const directRows = rows.filter((row) => row.role === "user");
  const sourceRows = directRows.length > 0 ? directRows : rows;
  const unique = new Map<string, EvidenceOperatorRow>();
  for (const row of sourceRows) {
    if (row.dedupeKey !== undefined && !unique.has(row.dedupeKey)) {
      unique.set(row.dedupeKey, row);
    }
  }
  const cumulative = [...unique.values()]
    .filter((row) => row.valueKind === "cumulative" || row.valueKind === "snapshot")
    .filter((row) => parseSourceTimestamp(records.get(row.memoryId)!.timestamp) !== undefined)
    .sort(compareRows);
  const latest = cumulative.at(-1);

  return {
    version: "picorer-evidence-operators-v1",
    operator: "numeric",
    rows: rows.slice(0, 40),
    coverage: {
      candidateCount: hits.length,
      distinctSessions: new Set(hits.map((hit) => hit.record.sessionId)).size,
      truncated: rows.length > 40,
    },
    derived: {
      ...(latest === undefined
        ? {}
        : {
            latestCumulativeOrSnapshot: latest.value,
            latestUnit: latest.unit,
            latestMemoryId: latest.memoryId,
          }),
      excludedTargetCount: [...unique.values()].filter((row) => row.valueKind === "target").length,
    },
  };
}
