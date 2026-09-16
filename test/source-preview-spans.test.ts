import { describe, expect, it } from "vitest";
import { sourcePreviewSpans } from "../src/evidence-agent/model/source-preview-spans.js";

describe("source preview spans", () => {
  it("completes a nearby sentence cut by a query-centred preview", () => {
    const content = [
      "15800. The chief executive officer of Toyota is Al-Waleed bin Talal.",
      "15801. Parambrata Chatterjee is a citizen of India.",
      "15802. Allen Ginsberg is famous for Natya Shastra.",
      "15803. The Illinois Attorney General is Ben Carson.",
    ].join(" ");
    const preview =
      "… executive officer of Toyota is Al-Waleed bin Talal. " +
      "15801. Parambrata Chatterjee is a citizen of India. " +
      "15802. Allen Ginsberg is famous …";

    const spans = sourcePreviewSpans(content, preview);
    const recovered = spans.map((span) => content.slice(span.start, span.end)).join("\n");

    expect(recovered).toContain(
      "15802. Allen Ginsberg is famous for Natya Shastra.",
    );
  });

  it("does not invent a source span for a non-verbatim preview", () => {
    expect(sourcePreviewSpans("The stored source is immutable.", "different text"))
      .toEqual([]);
  });
});
