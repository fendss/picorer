import { Agent } from "@earendil-works/pi-agent-core";
import type { PiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import {
  assistantMessageText,
  aggregateAssistantUsage,
  lastAssistantMessage,
} from "../../../evidence-agent/index.js";
import {
  assertNonEmpty,
  newRunId,
  sha256,
} from "../../../util.js";
import {
  returnedModelMatches,
  BenchmarkAnswerError,
  type BenchmarkAnswerPrompt,
  type BenchmarkAnswerResult,
} from "../../model/answer.js";

/** Runs benchmark-owned answer synthesis after Picorer has finished retrieval. */
function answerSystemPrompt(
  prompt: BenchmarkAnswerPrompt,
  executionChecklist?: string,
): string {
  return [prompt.systemPrompt.trim(), executionChecklist?.trim()]
    .filter(Boolean)
    .join("\n\n");
}

export async function runBenchmarkAnswer(options: {
  modelRuntime: PiModelRuntime;
  prompt: BenchmarkAnswerPrompt;
  maxRunMs?: number;
  executionChecklist?: string;
}): Promise<BenchmarkAnswerResult> {
  const maxRunMs = options.maxRunMs ?? 120_000;
  const systemPrompt = answerSystemPrompt(options.prompt, options.executionChecklist);
  const userPrompt = assertNonEmpty(options.prompt.userPrompt, "answer prompt");
  const promptIdentity = {
    promptAdapter: options.prompt.adapterId,
    promptVersion: options.prompt.promptVersion,
    promptHash: sha256(`${systemPrompt}\0${userPrompt}`),
  };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: options.modelRuntime.model,
      thinkingLevel: options.modelRuntime.thinkingLevel,
      tools: [],
    },
    streamFn: (model, context, streamOptions) =>
      options.modelRuntime.streamFn(model, context, {
        ...streamOptions,
        temperature: 0,
      }),
    getApiKey: options.modelRuntime.getApiKey,
    sessionId: newRunId(),
  });
  const failure = (message: string) => new BenchmarkAnswerError(message, {
    ...promptIdentity,
    usage: aggregateAssistantUsage(agent.state.messages),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, maxRunMs);
  timer.unref();
  try {
    await agent.prompt(userPrompt);
  } catch (error) {
    throw failure(timedOut
      ? `Benchmark answer stage exceeded ${maxRunMs}ms`
      : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
  const message = lastAssistantMessage(agent.state.messages);
  if (timedOut) {
    throw failure(`Benchmark answer stage exceeded ${maxRunMs}ms`);
  }
  if (!message) throw failure("Benchmark answer stage returned no assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw failure(
      message.errorMessage ??
        `Benchmark answer stage stopped with ${message.stopReason}`,
    );
  }
  const answer = assistantMessageText(message).trim();
  if (!answer) throw failure("Benchmark answer stage returned empty text");
  const responseModel = message.responseModel ?? message.model;
  if (!returnedModelMatches(options.modelRuntime.modelId, responseModel)) {
    throw failure(
      `Benchmark answer provider substituted model ${responseModel}; expected ${options.modelRuntime.modelId}`,
    );
  }
  return {
    answer,
    ...promptIdentity,
    model: {
      providerId: options.modelRuntime.providerId,
      modelId: options.modelRuntime.modelId,
      responseModels: [responseModel],
      thinkingLevel: options.modelRuntime.thinkingLevel,
      transport: options.modelRuntime.transport,
      responseModel,
    },
    usage: message.usage,
  };
}
