import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MemoryLedger } from "../../model/ledger.js";
import { RewriteWorkingMemory } from "../../model/rewrite-working-memory.js";
import { WORKING_MEMORY_MAX_CHARS } from "../../model/working-memory.js";
import { createWorkingMemoryObservation } from "./working-memory-observation.js";
import { renderReadReceipts } from "./read-receipts.js";

export const REWRITE_WORKING_MEMORY_PROMPT = `
Context policy: working-memory-rewrite.
workingMemory is an optional short progress note. A string replaces the note;
omission or null keeps it unchanged. Write only the current state in plain text:
- Established: facts that are supported by source text you have read.
- Missing: facts or relationships still needed to answer the question.
Preserve every still-relevant fact and gap when replacing the note. Remove a fact
when later evidence overturns it. Do not put candidate handles, evidence handles,
source IDs, search history, or a reasoning transcript in the note.

Search results are navigation for the current decision. Read a promising candidate
before moving to another search; previews alone are not established facts. The
harness keeps source identity, exact read evidence, compact read receipts, audit
history, and the final evidence package. You do not need to copy or maintain them.
After your next successful tool action, the harness removes prior raw tool results
from active context. A failed action keeps them visible for correction.

Use the Missing facts to choose the next search. Treat a relationship as established
only after reading source text that states it; do not fill a missing relationship
from world knowledge. Decide whether the acquired sources are adequate for answering.
If the remaining budget cannot resolve an important gap, finish insufficient. The
program commits all read parent-backed evidence. A final note and evidenceSummary
are optional.
`;

export const COMPACT_REWRITE_WORKING_MEMORY_PROMPT = `
Context policy: compact working memory.
After each successful action, the harness removes old tool payloads and keeps
exact read sources privately. workingMemory is optional plain text. When it
changes, replace it with only:
- Established: source-supported facts still relevant to the question.
- Missing: facts or relationships still needed.
Do not include handles, candidate lists, search history, or reasoning. Use the
missing fact to choose the next query and, when useful, the next operator or
operator composition. Treat only relationships stated by source text you have
read as established; do not substitute world knowledge for a missing relation.
Decide whether the acquired sources are adequate for answering, or finish
insufficient when an important gap cannot be resolved within the remaining budget.
`;

/** Notes are optional annotations. Only real tool arguments authorize source reads. */
export function createRewriteWorkingMemoryContext(
  ledger: MemoryLedger,
  maxSearchCalls?: number,
  compact = false,
) {
  const memory = new RewriteWorkingMemory(() => {});
  const observation = createWorkingMemoryObservation(ledger, maxSearchCalls, {
    refreshResults: true,
    compact,
  });
  const acknowledged = new Set<string>();
  const expiredNavigation = new Set<string>();
  const expiredReads = new Set<string>();
  let visible = new Set<string>();
  const noteParameters = Type.Optional(Type.Union([Type.String(), Type.Null()], {
    description: "Optional replacement progress note, up to 1600 characters. Use plain text with Established facts and Missing facts. Do not include source handles, IDs, candidate lists, search history, or reasoning. Omit or use null to keep the note unchanged.",
  }));

  return {
    observation,
    // Keep the tool contract stable for the whole run. The search tool owns
    // budget enforcement and returns a precise error after exhaustion. Removing
    // the tool here turns an ordinary budget boundary into "tool not found",
    // which gives the model no reliable way to recover.
    availableTools: (tools: readonly AgentTool[]) => [...tools],
    workingMemorySnapshot: () => memory.snapshot(),
    wrapTools(tools: readonly AgentTool[]): AgentTool[] {
      return tools.map(tool => {
        const parameters = tool.parameters as ReturnType<typeof Type.Object>;
        if (parameters.type !== "object" || !parameters.properties) {
          throw new Error(`Working-memory policy requires object arguments for ${tool.name}`);
        }
        return {
          ...tool,
          parameters: { ...parameters,
            properties: { ...parameters.properties, workingMemory: noteParameters },
            required: (parameters.required ?? []).filter(key => key !== "workingMemory"),
          },
          async execute(id, params, signal, onUpdate) {
            signal?.throwIfAborted();
            const { workingMemory, ...nativeParams } = params as Record<string, unknown>;
            const seen = [...visible];
            const next = typeof workingMemory === "string" ? workingMemory.trim() : undefined;
            const unchanged = workingMemory === undefined || workingMemory === null;
            const rejection = unchanged ? undefined
              : next === undefined || next.length === 0 ? "Expected a nonempty text note."
              : next.length > WORKING_MEMORY_MAX_CHARS
                ? `Note has ${next.length} characters; maximum is ${WORKING_MEMORY_MAX_CHARS}.` : undefined;
            // Failed native actions preserve both the previous note and observations.
            const result = await tool.execute(id, nativeParams, signal, onUpdate);
            const commit = memory.apply(unchanged || rejection ? undefined : next, id);
            // Context retirement is a harness concern. Any successful action has
            // consumed the results from the preceding model input, regardless of
            // whether the optional progress note changed. Failed actions throw
            // before this point and therefore preserve that input for correction.
            const acknowledgedToolCallIds = seen;
            for (const resultId of acknowledgedToolCallIds) acknowledged.add(resultId);
            return { ...result,
              content: [...result.content, ...(rejection ? [{ type: "text" as const,
                text: `Working-memory note was not updated: ${rejection} The action succeeded and the previous note remains. Prior raw results follow the normal harness-managed lifecycle. Write a shorter note on a later action if useful.` }] : [])],
              details: { ...result.details, workingMemoryUpdate: { ...commit, acknowledgedToolCallIds,
                ...(rejection ? { rejected: true, reason: rejection } : {}) } },
            };
          },
        };
      });
    },
    async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
      const pending = new Set(messages.flatMap(message => message.role === "toolResult" &&
        !acknowledged.has(message.toolCallId) ? [message.toolCallId] : []));
      visible = pending;
      const retained: AgentMessage[] = [];
      for (const message of messages) {
        if (message.role === "user") retained.push(message);
        else if (message.role === "assistant") {
          const content = message.content.filter(block => block.type === "toolCall" && pending.has(block.id));
          if (content.length) retained.push({ ...message, content });
        } else if (message.role === "toolResult") {
          if (pending.has(message.toolCallId)) {
            const { details: _audit, ...modelMessage } = message;
            retained.push(modelMessage);
          } else (message.toolName === "read" ? expiredReads : expiredNavigation).add(message.toolCallId);
        }
      }
      const firstAction = retained.findIndex(message => message.role !== "user");
      retained.splice(firstAction < 0 ? retained.length : firstAction, 0, {
        role: "user", timestamp: 0,
        content: memory.render() + "\n" + renderReadReceipts(ledger) +
          `\nSearch calls remaining: ${observation.searchesRemaining() ?? "unbounded"}.`,
      });
      return retained;
    },
    snapshot: () => ({ expiredNavigationResults: expiredNavigation.size, compactedReadResults: expiredReads.size }),
  };
}
