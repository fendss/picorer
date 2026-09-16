import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

const NAVIGATION_TOOLS = new Set([
  "search",
  "search_more",
  "define_operator",
  "bash_ro",
]);

export interface EphemeralContextSnapshot {
  expiredNavigationResults: number;
  compactedReadResults: number;
}

export interface EphemeralMemoryContext {
  transformContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
  snapshot(): EphemeralContextSnapshot;
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function trailingToolResultStart(messages: readonly AgentMessage[]): number {
  let index = messages.length;
  while (index > 0 && isToolResult(messages[index - 1]!)) index -= 1;
  return index;
}

/**
 * Keeps the current tool batch visible once, then expires navigation payloads.
 * Full results remain in the audit trace and ledger. Every read in a tool
 * batch reaches the model once; later turns retain only E-handle receipts in
 * the latest observation instead of replaying raw inspected evidence.
 */
export function createEphemeralMemoryContext(): EphemeralMemoryContext {
  const expiredNavigationIds = new Set<string>();
  const compactedReadIds = new Set<string>();
  return {
    async transformContext(messages): Promise<AgentMessage[]> {
      const currentBatchStart = trailingToolResultStart(messages);
      return messages.map((message, index) => {
        if (
          !isToolResult(message) ||
          (!NAVIGATION_TOOLS.has(message.toolName) && message.toolName !== "read") ||
          message.isError
        ) {
          return message;
        }
        // Preserve every result in the current batch. Keeping only the final
        // read would discard exact evidence before the model could reason over it.
        if (index >= currentBatchStart) return message;
        const read = message.toolName === "read";
        if (read) compactedReadIds.add(message.toolCallId);
        else expiredNavigationIds.add(message.toolCallId);
        return {
          ...message,
          content: [{
            type: "text" as const,
            text: read
              ? "[exact read payload removed from active context; it remains " +
                "in the final-source ledger and the latest <MEMORY> snapshot " +
                "retains only its E-handle receipt.]"
              : message.toolName === "search" || message.toolName === "search_more"
              ? "[search payload expired from active context; discovered uninspected " +
                "candidates remain directly readable in the latest <MEMORY> directory.]"
              : `[${message.toolName} navigation output expired from active ` +
                "context; full output remains in the audit trace.]",
          }],
        };
      });
    },
    snapshot(): EphemeralContextSnapshot {
      return {
        expiredNavigationResults: expiredNavigationIds.size,
        compactedReadResults: compactedReadIds.size,
      };
    },
  };
}
