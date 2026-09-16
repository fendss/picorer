import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

export function validateFinishToolBatch(
  toolNames: readonly string[],
  finishToolName = "finish",
): string | undefined {
  if (!toolNames.includes(finishToolName)) return undefined;
  return toolNames.length === 1 && toolNames[0] === finishToolName
    ? undefined
    : `${finishToolName} must be the only tool call in its assistant turn; ` +
      "observe this turn's tool results before finishing in a later turn";
}

export function createFinishOnlyBeforeToolCall(
  finishToolName = "finish",
): (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> {
  return async (context) => {
    const toolNames = context.assistantMessage.content
      .filter(
        (
          block,
        ): block is Extract<
          AssistantMessage["content"][number],
          { type: "toolCall" }
        > => block.type === "toolCall",
      )
      .map((call) => call.name);
    const reason = validateFinishToolBatch(toolNames, finishToolName);
    if (reason === undefined) return undefined;
    if (context.toolCall.name !== finishToolName) return undefined;
    return {
      block: true,
      reason,
    };
  };
}

export function createToolProtocolBeforeToolCall(): (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> {
  const enforceFinishOnly = createFinishOnlyBeforeToolCall();
  return async (context, signal) => {
    return enforceFinishOnly(context, signal);
  };
}
