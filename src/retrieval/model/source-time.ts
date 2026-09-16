import type { MemoryRecord } from "../../memory/index.js";

const SOURCE_TIME = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:(?:\s*\([A-Za-z]{3}\))?[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/iu;

/** Calendar validation must not silently roll February 31 into March. */
export function calendarTimestamp(year: number, month: number, day: number): number | undefined {
  if (![year, month, day].every(Number.isSafeInteger)) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day ? date.getTime() : undefined;
}

/** ISO instants and legacy source dates; timestamps without a zone use UTC. */
export function parseSourceTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = SOURCE_TIME.exec(value.trim());
  if (!match) return undefined;
  const day = calendarTimestamp(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (day === undefined || hour > 23 || minute > 59 || second > 59) return undefined;
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const zone = match[8];
  let offset = 0;
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2) || 0);
    if (hours > 23 || minutes > 59) return undefined;
    offset = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
  }
  return day + ((hour * 60 + minute - offset) * 60 + second) * 1_000 + milliseconds;
}

/** Relative calendar expressions refer to the date written at the source. */
export function sourceCalendarTimestamp(value: string | undefined): number | undefined {
  if (parseSourceTimestamp(value) === undefined) return undefined;
  const match = SOURCE_TIME.exec(value!.trim())!;
  return calendarTimestamp(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Missing/invalid timestamps remain last in both chronological directions. */
export function compareMemoryChronology(
  left: MemoryRecord,
  right: MemoryRecord,
  direction: 1 | -1 = 1,
): number {
  const leftTime = parseSourceTimestamp(left.timestamp);
  const rightTime = parseSourceTimestamp(right.timestamp);
  if (leftTime === undefined && rightTime !== undefined) return 1;
  if (leftTime !== undefined && rightTime === undefined) return -1;
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
    return direction * (leftTime - rightTime);
  }
  return left.sessionId.localeCompare(right.sessionId) ||
    direction * (left.turnIndex - right.turnIndex) ||
    left.memoryId.localeCompare(right.memoryId);
}
