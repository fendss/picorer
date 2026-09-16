import { describe, expect, it } from "vitest";
import {
  PICORER_TOOL_SYSTEM_PROMPT,
  PICORER_MINIMAL_SKILL_HASH,
  PICORER_MINIMAL_SKILL_TEXT,
  PICORER_SKILL_HASH,
  PICORER_SKILL_TEXT,
  picorerSystemPrompt,
} from "../src/evidence-agent/index.js";
import type { SearchOperatorCatalogEntry } from "../src/retrieval/index.js";

describe("runtime Skill experiment boundary", () => {
  it("keeps the default retrieval policy mechanics-only", () => {
    const none = picorerSystemPrompt("none");
    const minimal = picorerSystemPrompt("picorer-minimal");
    const current = picorerSystemPrompt("picorer-v0");

    expect(none).not.toContain("<active_skill");
    expect(minimal.startsWith(`${none}\n\n`)).toBe(false);
    expect(current.startsWith(`${none}\n\n`)).toBe(true);
    expect(minimal).toContain(PICORER_MINIMAL_SKILL_TEXT);
    expect(current).toContain(PICORER_SKILL_TEXT);
    expect(current).toContain('<active_skill name="picorer-retrieval"');
    expect(current).not.toMatch(
      /closed-slot|open-set|LongMemEval|benchmark|calendar-day/iu,
    );
    expect(none).toBe(PICORER_TOOL_SYSTEM_PROMPT);
    expect(PICORER_SKILL_HASH).toMatch(/^[a-f0-9]{64}$/u);
    expect(PICORER_MINIMAL_SKILL_HASH).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("adds progressive inline composition without task-specific routing", () => {
    expect(PICORER_SKILL_TEXT).not.toBe(PICORER_MINIMAL_SKILL_TEXT);
    expect(PICORER_SKILL_TEXT).toContain(
      "without imposing a task-specific reasoning strategy",
    );
    expect(PICORER_SKILL_TEXT).toContain("Search spans all source roles");
    expect(PICORER_SKILL_TEXT).toContain(
      "`queries` only. Add `order` or `maxPerSession`",
    );
    expect(PICORER_SKILL_TEXT).toContain(
      "hybrid primary path plus a lexical",
    );
    expect(PICORER_SKILL_TEXT).toContain(
      "Useful evidence may be direct, analogous, or distributed across sources",
    );
    expect(PICORER_SKILL_TEXT).toContain(
      "does not need to repeat the caller's requested answer verbatim",
    );
    expect(PICORER_SKILL_TEXT).toContain(
      "Call `finish` by itself after observing the preceding tool results",
    );
    expect(PICORER_SKILL_TEXT).not.toMatch(
      /closed-slot|open-set|temporal|list|count|LongMemEval|benchmark/iu,
    );
  });

  it("keeps the operator catalog available in the compact presentation", () => {
    const catalog: SearchOperatorCatalogEntry[] = [{
      id: "entity-expand",
      version: "1",
      guide: {
        summary: "Follow entity associations.",
        useWhen: ["An entity anchor is available."],
        cost: "medium",
      },
    }];

    for (const skill of ["none", "picorer-v0"] as const) {
      const prompt = picorerSystemPrompt(skill, undefined, catalog);
      expect(prompt).toContain("id=entity-expand | version=1");
      expect(prompt).not.toContain("entity-expand@1");
    }
    expect(picorerSystemPrompt("picorer-minimal", undefined, catalog)).toContain(
      "id=entity-expand | version=1",
    );
  });
});
