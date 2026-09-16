import { createHash, randomUUID } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function responseModelMatchesRequested(
  requested: string,
  actual: string,
): boolean {
  if (actual === requested) return true;
  const datedVersionOf = (model: string): boolean =>
    actual.startsWith(`${model}-`) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(actual.slice(model.length + 1));
  if (datedVersionOf(requested)) return true;

  // Some OpenAI-compatible providers expose explicit routing aliases such as
  // `gpt-5-mini-medium`, but report the canonical dated model that actually
  // served the request. Accept only a known routing suffix and the exact base
  // family; callers still record both requested and returned identities.
  const routedBase = requested.match(
    /^(.*)-(?:minimal|low|medium|high|xhigh|fast|flex)$/u,
  )?.[1];
  return routedBase !== undefined &&
    (actual === routedBase || datedVersionOf(routedBase));
}

export function stableMemoryId(
  scopeId: string,
  sessionId: string,
  turnIndex: number,
  sourceId?: string,
): string {
  const turnPart =
    sourceId?.trim() || `t${String(turnIndex).padStart(4, "0")}`;
  return `m-${sha256(`${scopeId}\0${sessionId}\0${turnPart}`).slice(0, 24)}`;
}

export function compactPreview(text: string, maxLength = 280): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Keeps both setup and the sentence-final episodic fact in search previews. */
export function episodicPreview(text: string, maxLength = 360): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxLength) return compact;
  const separator = " … ";
  const available = Math.max(0, maxLength - separator.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${compact.slice(0, headLength)}${separator}${compact.slice(-tailLength)}`;
}

function previewQueryTermWeights(query: string): Map<string, number> {
  const counts = new Map<string, number>();
  const tokens = query
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:[&./+-][\p{L}\p{N}]+)*/gu)
    ?.filter((token) =>
      token.replace(/[^\p{L}\p{N}]/gu, "").length > 2 ||
      /[&./+-]/u.test(token)
    ) ?? [];
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return new Map([...counts].map(([term, count]) => [
    term,
    Math.min(term.length, 24) * (1 + Math.log2(count)),
  ]));
}

function sentenceStart(text: string, index: number): number {
  for (let cursor = Math.min(index - 1, text.length - 1); cursor >= 0; cursor -= 1) {
    if (/[.!?]/u.test(text[cursor]!) && text[cursor + 1] === " ") {
      return cursor + 2;
    }
  }
  return 0;
}

function sentenceEnd(text: string, index: number): number {
  for (let cursor = Math.max(0, index); cursor < text.length; cursor += 1) {
    if (/[.!?]/u.test(text[cursor]!) &&
      (cursor + 1 === text.length || text[cursor + 1] === " ")) {
      return cursor + 1;
    }
  }
  return text.length;
}

interface PreviewSpan {
  start: number;
  end: number;
}

function centeredPreviewSpan(
  compact: string,
  center: number,
  maxLength: number,
): PreviewSpan {
  const contentBudget = Math.max(1, maxLength - 4);
  const fullSentenceStart = sentenceStart(compact, center);
  const fullSentenceEnd = sentenceEnd(compact, center);
  const sentenceLength = fullSentenceEnd - fullSentenceStart;
  let start: number;
  if (sentenceLength <= contentBudget) {
    const spare = contentBudget - sentenceLength;
    start = Math.max(0, fullSentenceStart - Math.floor(spare / 2));
    start = Math.min(start, Math.max(0, compact.length - contentBudget));
  } else {
    start = Math.max(0, center - Math.floor(contentBudget / 2));
    start = Math.min(start, Math.max(0, compact.length - contentBudget));
  }
  let end = Math.min(compact.length, start + contentBudget);
  if (start > 0) {
    const boundary = compact.indexOf(" ", start);
    if (boundary >= 0 && boundary < end) start = boundary + 1;
  }
  if (end < compact.length) {
    const boundary = compact.lastIndexOf(" ", end);
    if (boundary > start) end = boundary;
  }
  return { start, end };
}

function renderPreviewSpan(compact: string, span: PreviewSpan): string {
  const prefix = span.start > 0 ? "… " : "";
  const suffix = span.end < compact.length ? " …" : "";
  return `${prefix}${compact.slice(span.start, span.end)}${suffix}`;
}

/**
 * Centers a bounded preview on the strongest cluster of query terms.
 * Semantic-only matches fall back to the setup-plus-ending episodic preview.
 */
export function queryCenteredEpisodicPreview(
  text: string,
  query: string,
  maxLength = 360,
): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxLength) return compact;
  const lower = compact.toLowerCase();
  const termWeights = previewQueryTermWeights(query);
  const terms = [...termWeights.keys()];
  const occurrences: number[] = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(term, from);
      if (index < 0) break;
      occurrences.push(index);
      from = index + Math.max(1, term.length);
    }
  }
  if (occurrences.length === 0) return episodicPreview(compact, maxLength);

  const contentBudget = Math.max(1, maxLength - 4);
  let bestCenter = occurrences[0]!;
  let bestScore = -1;
  let bestMatches = -1;
  for (const center of occurrences) {
    const start = Math.max(0, center - Math.floor(contentBudget / 2));
    const window = lower.slice(start, start + contentBudget);
    const matched = terms.filter((term) => window.includes(term));
    const score = matched.reduce(
      (sum, term) => sum + (termWeights.get(term) ?? 0),
      0,
    );
    if (score > bestScore ||
      (score === bestScore && matched.length > bestMatches) ||
      (score === bestScore && matched.length === bestMatches && center < bestCenter)) {
      bestCenter = center;
      bestScore = score;
      bestMatches = matched.length;
    }
  }

  return renderPreviewSpan(
    compact,
    centeredPreviewSpan(compact, bestCenter, maxLength),
  );
}

export function safePathSegment(value: string): string {
  const readable = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `${readable || "scope"}-${sha256(value).slice(0, 12)}`;
}

export function newRunId(): string {
  return randomUUID();
}

export function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}
