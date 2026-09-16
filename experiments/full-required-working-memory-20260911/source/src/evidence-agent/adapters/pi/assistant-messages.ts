import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelUsage } from "../../model/evidence.js";
import { responseModelMatchesRequested } from "../../../util.js";

export function lastAssistantMessage(
  messages: readonly unknown[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
    ) {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

export function assistantMessageText(
  message: AssistantMessage | undefined,
  maxChars?: number,
): string {
  if (!message) return "";
  const text = message.content
    .filter(
      (block): block is Extract<
        AssistantMessage["content"][number],
        { type: "text" }
      > => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  return maxChars === undefined ? text : text.slice(0, maxChars);
}

function responseModelMatches(requested: string, actual: string): boolean {
  return responseModelMatchesRequested(requested, actual);
}

export function validateResponseModels(
  messages: readonly unknown[],
  requestedModel: string,
): string[] {
  const responseModels = new Set<string>();
  for (const message of messages) {
    if (
      typeof message !== "object" || message === null ||
      !("role" in message) || message.role !== "assistant"
    ) continue;
    const assistant = message as AssistantMessage;
    const actual = assistant.responseModel ?? assistant.model;
    if (!responseModelMatches(requestedModel, actual)) {
      throw new Error(
        `Provider substituted model ${actual}; expected ${requestedModel}`,
      );
    }
    responseModels.add(actual);
  }
  if (responseModels.size === 0) {
    throw new Error("Provider response model is missing");
  }
  return [...responseModels].sort();
}

export function aggregateAssistantUsage(
  messages: readonly unknown[],
): ModelUsage {
  const usage: ModelUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  let cacheWrite1h: number | undefined;
  let reasoning: number | undefined;
  for (const message of messages) {
    if (
      typeof message !== "object" || message === null ||
      !("role" in message) || message.role !== "assistant"
    ) continue;
    const item = (message as AssistantMessage).usage;
    usage.input += item.input;
    usage.output += item.output;
    usage.cacheRead += item.cacheRead;
    usage.cacheWrite += item.cacheWrite;
    usage.totalTokens += item.totalTokens;
    usage.cost.input += item.cost.input;
    usage.cost.output += item.cost.output;
    usage.cost.cacheRead += item.cost.cacheRead;
    usage.cost.cacheWrite += item.cost.cacheWrite;
    usage.cost.total += item.cost.total;
    if (item.cacheWrite1h !== undefined) {
      cacheWrite1h = (cacheWrite1h ?? 0) + item.cacheWrite1h;
    }
    if (item.reasoning !== undefined) {
      reasoning = (reasoning ?? 0) + item.reasoning;
    }
  }
  return {
    ...usage,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}
