import { calendarTimestamp } from "./model/source-time.js";
import type { RetrievalMetadataFilter } from "./model/search.js";

const STRUCTURED_DATE = /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/gu;

function normalizedCalendarDate(
  yearText: string,
  monthText: string,
  dayText: string,
): string | undefined {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (calendarTimestamp(year, month, day) === undefined) return undefined;
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

/**
 * Extracts one unambiguous, calendar-valid date already written in an Agent
 * query. Multiple dates are deliberately left to the Agent: treating them as
 * either separate days or a range would add semantics that were not expressed.
 */
export function explicitQueryDateFilter(
  query: string,
): RetrievalMetadataFilter | undefined {
  const dates = new Set<string>();
  let invalidDate = false;
  for (const match of query.matchAll(STRUCTURED_DATE)) {
    const date = normalizedCalendarDate(match[1]!, match[2]!, match[3]!);
    if (date === undefined) invalidDate = true;
    else dates.add(date);
  }
  if (invalidDate || dates.size !== 1) return undefined;
  const date = [...dates][0]!;
  return {
    source: "agent-query",
    query,
    expression: date,
    after: `${date}T00:00:00`,
    before: `${date}T23:59:59.999`,
  };
}
