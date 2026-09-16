import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MemoryLedger } from "../../model/ledger.js";
import { IncrementalWorkingMemory, WORKING_MEMORY_MAX_CHARS, WORKING_MEMORY_MAX_OPERATIONS } from "../../model/working-memory.js";
import { createRewriteWorkingMemoryContext } from "./rewrite-working-memory-context.js";
export {
  COMPACT_REWRITE_WORKING_MEMORY_PROMPT,
  REWRITE_WORKING_MEMORY_PROMPT,
} from "./rewrite-working-memory-context.js";
import { createWorkProgress, WorkProgressParameters } from "./work-progress-contract.js";
import { createWorkingMemoryObservation } from "./working-memory-observation.js";

export const WORKING_MEMORY_POLICY_PROMPT = `
Context policy: working-memory-v2 (incremental entries).
Only the original question, your active workingMemory entries, and tool results you have
not yet acknowledged are retained. Old assistant reasoning and candidate lists
are not replayed. Candidate and evidence records remain available privately.

Every tool call must contain workingMemory: an array of local changes, or null
to explicitly keep all entries unchanged. Use null on the first search if needed.
After seeing the first tool result, add an initial entry before proceeding.
Add only new information with {"op":"add","text":"..."}; the program assigns
a W ID shown in the next context. Use {"op":"update","id":"W1","text":"..."}
to correct only that entry, or {"op":"retire","id":"W1","reason":"..."}
to explicitly retire it. Entries absent from a patch are ALWAYS retained.
Do not resend or rewrite the entire notebook. Example: once W1 records a first
relation with its source, add W2 for the next relation; W1 remains available.
Keep entries small so updating one judgment does not overwrite other judgments.
An update or retirement is retained in the audit, including the previous text.
The active-entry budget is 1600 characters. Invalid or over-budget patches are
rejected atomically: nothing is silently dropped or truncated.
Keep the current evidence-supported conclusions, their C or E refs, unresolved
relations, and useful uninspected C refs. Distinguish hypotheses from verified
facts. If new evidence changes a conclusion, revise the affected next steps.
Do not copy long passages or write a reasoning transcript. An E ref may only
refer to a source already returned by read; use a C ref for an uninspected finding.
The entries are your fallible working record, not source evidence. Reopen a known C
ref with read when its exact wording is needed. A repeated parent may contain
newly displayed facts. New tool results are kept until a valid note update or
explicit unchanged decision acknowledges them. No separate state tool is needed.
The final answer handoff still uses exact read sources, not the working note.
`;

export function createWorkingMemoryContext(
  ledger: MemoryLedger,
  maxSearchCalls?: number,
  mode: "entries" | "progress" | "rewrite" = "entries",
  compact = false,
) {
  if (mode === "rewrite") {
    return createRewriteWorkingMemoryContext(ledger, maxSearchCalls, compact);
  }
  const progress = mode === "progress";
  const optionalNotes = mode !== "entries";
  const acknowledged = new Set<string>();
  const expiredNavigation = new Set<string>();
  const expiredReads = new Set<string>();
  let visible = new Set<string>();
  const work = progress ? createWorkProgress(ledger) : undefined;
  const observation = createWorkingMemoryObservation(ledger, maxSearchCalls, work ? { recordShown: work.recordShown } : {});
  const validateReferences = (text: string) => {
    const refs = [...new Set(text.match(/\b[CE][1-9]\d*\b/gu) ?? [])];
    const evidenceRefs = new Set(ledger.inspectedEvidence.map((e) => ledger.evidenceRef(e.memoryId)));
    for (const ref of refs) {
      if (ref.startsWith("C")) ledger.resolveCandidates([ref]);
      else if (!evidenceRefs.has(ref)) throw new Error(`Unknown workingMemory evidence ref ${ref}; use a returned C ref until its source has been read.`);
    }
  };
  const memory = work?.memory ?? new IncrementalWorkingMemory(validateReferences);
  const text = Type.String({ minLength: 1, maxLength: WORKING_MEMORY_MAX_CHARS });
  const id = Type.String({ pattern: "^W[1-9][0-9]*$" });
  const operation = Type.Union([
    Type.Object({ op: Type.Literal("add"), text }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("update"), id, text }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("retire"), id, reason: text }, { additionalProperties: false }),
  ]);

  const noteParameters = progress ? WorkProgressParameters : Type.Union([
    Type.Array(operation, { maxItems: WORKING_MEMORY_MAX_OPERATIONS }), Type.Null(),
  ], { description: "Incremental entries only: add new facts or gaps; update or retire a known W ID. Omitted entries stay intact. Null or [] explicitly keeps every entry unchanged. After the first tool result add an initial entry. The patch applies atomically before this action; a later action error does not undo it." });

  return {
    observation,
    // Search remains in the schema after the budget is spent. Execution-time
    // validation then reports the real budget error instead of a missing tool.
    availableTools: (tools: readonly AgentTool[]) => [...tools],
    wrapTools(tools: readonly AgentTool[]): AgentTool[] {
      return tools.map((tool) => {
        const parameters = tool.parameters as ReturnType<typeof Type.Object>;
        if (parameters.type !== "object" || parameters.properties === undefined) {
          throw new Error(`Working-memory policy requires object arguments for ${tool.name}`);
        }
        return ({
        ...tool,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            workingMemory: optionalNotes && tool.name !== "search" ? Type.Optional(noteParameters) : noteParameters,
          },
          required: optionalNotes && tool.name !== "search" ? (parameters.required ?? []).filter(k => k !== "workingMemory") : [...new Set([...(parameters.required ?? []), "workingMemory"])],
        },
        async execute(id, params, signal, onUpdate) {
          signal?.throwIfAborted();
          if (params === null || typeof params !== "object" || Array.isArray(params)) {
            throw new Error("Tool arguments must be an object");
          }
          const fields = params as Record<string, unknown>;
          const delta = fields.workingMemory;
          if ((!optionalNotes || tool.name === "search") && visible.size > 0 && !memory.initialized &&
              (delta === null || (Array.isArray(delta) && delta.length === 0))) {
            throw new Error("Add an initial workingMemory entry after observing tool results; describe unresolved needs when nothing is confirmed yet.");
          }
          if ((!optionalNotes || tool.name === "search") && delta === undefined) {
            throw new Error("workingMemory is required for this action; use null to explicitly keep it unchanged.");
          }
          const commit = memory.apply(delta, id);
          if (tool.name === "finish") work?.memory.assertFinish(fields.status);
          // Only acknowledge results in the preceding model input, never outputs
          // produced by earlier tools in this same assistant batch.
          const acknowledgedToolCallIds = optionalNotes && delta === undefined ? [] : [...visible];
          for (const resultId of acknowledgedToolCallIds) acknowledged.add(resultId);
          const { workingMemory: _note, ...nativeParams } = fields;
          const result = await tool.execute(id, nativeParams, signal, onUpdate);
          return { ...result, details: { ...result.details, workingMemoryUpdate: {
            ...commit, mode: commit.changes.length ? "patch" : "unchanged", acknowledgedToolCallIds,
          } } };
        },
        });
      });
    },
    async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
      const pendingIds = new Set(messages.flatMap((m) =>
        m.role === "toolResult" && !acknowledged.has(m.toolCallId) ? [m.toolCallId] : []
      ));
      visible = pendingIds;
      const retained: AgentMessage[] = [];
      for (const message of messages) {
        if (message.role === "user") retained.push(message);
        else if (message.role === "assistant") {
          const content = message.content.filter((b) => b.type === "toolCall" && pendingIds.has(b.id));
          if (content.length) retained.push({ ...message, content });
        } else if (message.role === "toolResult") {
          if (pendingIds.has(message.toolCallId)) {
            const { details: _audit, ...modelMessage } = message;
            retained.push(modelMessage);
          }
          else (message.toolName === "read" ? expiredReads : expiredNavigation).add(message.toolCallId);
        }
      }
      const firstAction = retained.findIndex((m) => m.role !== "user");
      retained.splice(firstAction < 0 ? retained.length : firstAction, 0, {
        role: "user", timestamp: 0,
        content: memory.render() + (optionalNotes ? `\nSearch calls remaining: ${observation.searchesRemaining() ?? "unbounded"}. ${observation.searchesRemaining() === 0 ? "New search is unavailable. Do not call search or invent replacement tools. Defining an operator cannot restore this budget. Use existing evidence, read stored C refs, or finish insufficient if gaps remain." : "search_more only exposes existing pages; read stored C refs when useful."}` : ""),
      });
      return retained;
    },
    snapshot() {
      return { expiredNavigationResults: expiredNavigation.size, compactedReadResults: expiredReads.size };
    },
    workingMemorySnapshot: () => memory.snapshot(),
  };
}
