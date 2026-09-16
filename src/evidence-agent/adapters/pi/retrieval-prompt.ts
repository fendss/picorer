import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  renderSearchOperatorCatalog,
  type SearchOperatorCatalogEntry,
} from "../../../retrieval/index.js";
import { sha256 } from "../../../util.js";

export type PicorerSkill = "none" | "picorer-minimal" | "picorer-v0";

export const PICORER_SKILL_VERSION = "picorer-v0-harness-context-13";
export const PICORER_MINIMAL_SKILL_VERSION = "picorer-minimal-compact-interface-9";

const DEFAULT_SKILL_PATH = fileURLToPath(
  new URL("../../../../.agents/skills/picorer-retrieval/SKILL.md", import.meta.url),
);

export const PICORER_SKILL_TEXT = readFileSync(DEFAULT_SKILL_PATH, "utf8");
export const PICORER_SKILL_HASH = sha256(PICORER_SKILL_TEXT);

const MINIMAL_SKILL_PATH = fileURLToPath(
  new URL(
    "../../../../.agents/skills/picorer-retrieval-minimal/SKILL.md",
    import.meta.url,
  ),
);

export const PICORER_MINIMAL_SKILL_TEXT = readFileSync(
  MINIMAL_SKILL_PATH,
  "utf8",
);
export const PICORER_MINIMAL_SKILL_HASH = sha256(PICORER_MINIMAL_SKILL_TEXT);

export const PICORER_TOOL_SYSTEM_PROMPT = `You are Picorer: a memory retrieval agent.

Your task is to locate source memories that may help a downstream model answer the caller's question. Do not answer or format the caller's final response.

Tool contract:
- search returns navigation candidates across all source roles available in the current scope. Queries alone use the default retriever, while optional branches, ordering, and session diversity form one inline retrieval program. Source roles are harness-owned metadata, not search arguments. Previews are not source evidence.
- search_more reveals another bounded page from the most recent search without changing its operator or queries.
- read takes candidate handles from the current search result and adds bounded exact source evidence to the final source package. Read useful candidates before moving to another search. If workingMemory is available, keep only the supported facts and remaining gaps in plain text; the harness owns source handles, read receipts, and context retirement.
- finish reports status; evidenceSummary is an optional audit note that should normally be omitted. The harness automatically commits every exact source returned by read and generates citations, hashes, provenance, and answer-package formatting. Observe prior tool results, then call finish as the only tool call in that assistant turn.
- The harness owns source identity, provenance, package limits, and formatting.`;

export const PICORER_MINIMAL_TOOL_SYSTEM_PROMPT = `You are Picorer, a memory retrieval agent.

Find direct source evidence for the caller. Do not answer the question.

- search accepts focused queries and returns one bounded page of candidates. Start with the default operator; select or compose catalog operators when another retrieval path is useful. The harness keeps later pages private until search_more.
- define_operator names a reusable composition of primitive search operators. Inline branches are enough for a one-off composition.
- read accepts a small set of visible candidate handles and returns exact source excerpts. The harness retains their full identity and provenance.
- Keep workingMemory short: only established facts and facts still missing. Do not copy handles, candidate lists, search history, or reasoning.
- Continue searching from the entity or relationship still missing. Decide from the exact sources read whether to finish sufficient, or finish insufficient when an important gap cannot be resolved within budget.
- The harness commits all read sources and prepares the final evidence package.`;

function activeSkillPrompt(skill: Exclude<PicorerSkill, "none">): string {
  const minimal = skill === "picorer-minimal";
  const name = minimal ? "picorer-retrieval-minimal" : "picorer-retrieval";
  const version = minimal ? PICORER_MINIMAL_SKILL_VERSION : PICORER_SKILL_VERSION;
  const text = minimal ? PICORER_MINIMAL_SKILL_TEXT : PICORER_SKILL_TEXT;
  return `<active_skill name="${name}" version="${version}">\n${text}\n</active_skill>`;
}

export function picorerSystemPrompt(
  skill: PicorerSkill = "picorer-v0",
  basePrompt?: string,
  operatorCatalog: readonly SearchOperatorCatalogEntry[] = [],
): string {
  const minimal = skill === "picorer-minimal";
  const resolvedBasePrompt = basePrompt ?? (
    minimal ? PICORER_MINIMAL_TOOL_SYSTEM_PROMPT : PICORER_TOOL_SYSTEM_PROMPT
  );
  const catalogPrompt = operatorCatalog.length === 0
    ? ""
    : `<search_operator_catalog>\n${renderSearchOperatorCatalog(operatorCatalog)}\n</search_operator_catalog>`;
  return [
    resolvedBasePrompt,
    catalogPrompt,
    ...(skill === "none" ? [] : [activeSkillPrompt(skill)]),
  ].filter(Boolean).join("\n\n");
}
