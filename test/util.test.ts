import { describe, expect, it } from "vitest";
import {
  episodicPreview,
  queryCenteredEpisodicPreview,
} from "../src/util.js";

describe("episodic previews", () => {
  it("preserves setup and sentence-final facts within a fixed budget", () => {
    const text = `${"setup ".repeat(80)}By the way, my personal best is 25:50.`;
    const preview = episodicPreview(text, 120);

    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview).toMatch(/^setup/u);
    expect(preview).toContain("personal best is 25:50");
    expect(preview).toContain(" … ");
  });

  it("centers lexical previews on the sentence containing the strongest query-term cluster", () => {
    const text = [
      "There is a lot to learn in full-stack development.",
      "Start with the fundamentals and practice by building small projects.",
      "Keep a regular schedule and ask experienced developers for feedback.",
      "Learn a back-end programming language that suits your interests, such as Ruby, Python, or PHP.",
      "Continue improving the project after each review.",
      "Join a developer community and keep learning over time.",
    ].join(" ");
    const preview = queryCenteredEpisodicPreview(
      text,
      "recommended back-end programming languages to learn",
      180,
    );

    expect(preview.length).toBeLessThanOrEqual(180);
    expect(preview).toContain("Ruby, Python, or PHP");
    expect(preview).toContain("Learn a back-end programming language");
  });

  it("keeps the episodic fallback when a semantic query has no literal anchor", () => {
    const text = `${"setup ".repeat(80)}The final fact is preserved.`;
    const preview = queryCenteredEpisodicPreview(text, "unrelated synonym", 120);

    expect(preview).toBe(episodicPreview(text, 120));
  });

  it("exposes a sentence-final actor-relation match from a long memory", () => {
    const text = [
      "I'm working on a project that involves analyzing customer data to identify trends and patterns.",
      "I was thinking of using clustering analysis, but I'm not sure which type of clustering method to use.",
      "Can you help me decide between k-means and hierarchical clustering?",
      "By the way, I've had some experience with data analysis from my Marketing Research class project, where I led the data analysis team and we did a comprehensive market analysis for a new product launch.",
    ].join(" ");

    const preview = queryCenteredEpisodicPreview(text, "I led the", 360);

    expect(preview).toContain("where I led the data analysis team");
  });

  it("prefers a span containing terms repeated across query reformulations", () => {
    const text = [
      "General shopping advice covers promotions, purchases, and order confirmations.",
      "Unrelated maintenance notes. ".repeat(100),
      "I currently have five blue widgets from Atlas & Co.",
    ].join(" ");

    const preview = queryCenteredEpisodicPreview(
      text,
      [
        "Atlas & Co blue widgets bought",
        "purchase Atlas & Co widget",
        "I bought widgets Atlas & Co",
        "widget order confirmation",
      ].join(" "),
    );

    expect(preview.length).toBeLessThanOrEqual(360);
    expect(preview).toContain("five blue widgets from Atlas & Co");
    expect(preview).not.toContain("General shopping advice");
  });
});
