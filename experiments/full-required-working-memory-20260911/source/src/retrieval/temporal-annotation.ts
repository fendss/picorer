import { parseSourceTimestamp, sourceCalendarTimestamp } from "./model/source-time.js";
export { parseSourceTimestamp } from "./model/source-time.js";

function durationParts(milliseconds: number): string {
  const totalMinutes = Math.round(Math.abs(milliseconds) / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (days === 0 && minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  return parts.join(" ") || "0 minutes";
}

export function temporalAnnotation(
  memoryTimestamp: string | undefined,
  questionDate: string | undefined,
): string | undefined {
  const memoryTime = parseSourceTimestamp(memoryTimestamp);
  if (memoryTime === undefined) return undefined;
  const date = new Date(sourceCalendarTimestamp(memoryTimestamp)!);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
  const questionTime = parseSourceTimestamp(questionDate);
  if (questionTime === undefined) return `weekday=${weekday}`;
  const delta = memoryTime - questionTime;
  const relation = delta <= 0 ? "before question" : "after question";
  return `weekday=${weekday}; ${durationParts(delta)} ${relation}`;
}
