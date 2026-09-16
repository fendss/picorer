import { mergeSpans, type SourceSpan } from "./source-evidence.js";
import type { RetrievalHit } from "../../retrieval/index.js";
import { queryCenteredEpisodicPreview } from "../../util.js";

const MAX_SENTENCE_BOUNDARY_EXTENSION = 256;

function isSentenceBoundary(content: string, index: number): boolean {
  return /[.!?]/u.test(content[index] ?? "") &&
    (index + 1 === content.length || /\s/u.test(content[index + 1] ?? ""));
}

/**
 * A query-centred preview may stop in the middle of the matched sentence.
 * Extend only an already recovered verbatim fragment, and only to a nearby
 * source boundary, so read never manufactures an unrelated source location.
 */
function completeNearbySentence(
  content: string,
  span: SourceSpan,
): SourceSpan {
  let start = span.start;
  const earliest = Math.max(0, start - MAX_SENTENCE_BOUNDARY_EXTENSION);
  for (let cursor = start - 1; cursor >= earliest; cursor -= 1) {
    if (!isSentenceBoundary(content, cursor)) continue;
    start = cursor + 1;
    while (start < span.start && /\s/u.test(content[start] ?? "")) start += 1;
    break;
  }

  let end = span.end;
  const latest = Math.min(content.length, end + MAX_SENTENCE_BOUNDARY_EXTENSION);
  for (let cursor = end; cursor < latest; cursor += 1) {
    if (!isSentenceBoundary(content, cursor)) continue;
    end = cursor + 1;
    break;
  }
  return { start, end };
}

/** Legacy adapters may return unbounded previews; store and display the same view. */
export function candidatePreview(hit: RetrievalHit): string {
  if (hit.passage !== undefined) return hit.passage.content;
  return hit.preview.length <= 360 ? hit.preview : queryCenteredEpisodicPreview(
    hit.preview, (hit.matchedQueries ?? [hit.query]).join(" "), 360,
  );
}

/** Recover only verbatim source fragments; whitespace compaction is reversible. */
export function sourcePreviewSpans(content: string, preview: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const fragment of new Set(preview.split(/…|\.{3}/u).map((part) => part.trim()))) {
    if (!fragment) continue;
    const pattern = fragment.split(/\s+/u)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s+");
    // Legacy previews lack hit coordinates. A deterministic exact occurrence
    // preserves their text, but does not claim to recover the retriever's
    // original occurrence. Passage candidates carry their own exact offsets.
    const match = new RegExp(pattern, "u").exec(content);
    if (match !== null) {
      spans.push(completeNearbySentence(content, {
        start: match.index,
        end: match.index + match[0].length,
      }));
    }
  }
  return mergeSpans(spans);
}
