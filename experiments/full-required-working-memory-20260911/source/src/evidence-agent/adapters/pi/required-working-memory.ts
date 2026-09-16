import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MemoryObservation } from "./memory-observation.js";

export const REQUIRED_WORKING_MEMORY_PROMPT = `
Working-memory requirement (full interface experiment):
After observing a tool result, every next tool call must include workingMemory.
Write a short current note describing what is established and what is still
missing. Replace outdated conclusions when new evidence changes your judgment.
Use null only to explicitly confirm an existing note is still current. Before
any tool result, the initial search may omit the note. Finish must also include
a current note or null to confirm it. The note limit remains 1600 characters.
Notes are fallible progress records, never source evidence. Tool history,
search operators and final source delivery follow the existing full interface.
`;

/** Require an explicit note decision without changing full-context retention. */
export function createRequiredWorkingMemory(observation: MemoryObservation) {
  let observedResult = false;
  let note: string | undefined;
  const parameter = Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 1600 }), Type.Null(),
  ], { description: "Required after a tool result and at finish: current progress and missing facts; null explicitly keeps an existing note. Initial search may omit it." }));

  return {
    observe(messages: readonly AgentMessage[]): void {
      // A preceding action in the same assistant batch has not been observed yet.
      if (messages.some(message => message.role === "toolResult")) observedResult = true;
    },
    wrapTools(tools: readonly AgentTool[]): AgentTool[] {
      return tools.map(tool => {
        const parameters = tool.parameters as ReturnType<typeof Type.Object>;
        return {
          ...tool,
          parameters: {
            ...parameters,
            properties: { ...parameters.properties, workingMemory: parameter },
          },
          async execute(id, params, signal, onUpdate) {
            signal?.throwIfAborted();
            const fields = params as Record<string, unknown>;
            const value = fields.workingMemory;
            if ((observedResult || tool.name === "finish") && value === undefined) {
              throw new Error("workingMemory is required after observing tool results and at finish. Write current progress, or use null to confirm the existing note.");
            }
            if (value === null && note === undefined) {
              throw new Error("No workingMemory exists yet. Write an initial note describing confirmed facts and unresolved needs.");
            }
            if (value !== undefined && value !== null) {
              if (typeof value !== "string") throw new Error("workingMemory must be a string or null.");
              // Same validation, limit and pre-action commit as native full notes.
              observation.recordWorkingMemory(value);
              note = value.trim();
            }
            const { workingMemory: _note, ...nativeParams } = fields;
            const result = await tool.execute(id, nativeParams, signal, onUpdate);
            return { ...result, details: { ...result.details, requiredWorkingMemory: {
              mode: value === undefined ? "initial-omitted" : value === null ? "confirmed" : "replaced",
              note: note ?? null,
              observedResult,
            } } };
          },
        };
      });
    },
  };
}
