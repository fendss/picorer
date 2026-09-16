import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  Type,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAINonStreamingStreamFn } from "../src/platform/pi/openai-non-stream-transport.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("OpenAI non-stream transport", () => {
  it("retains billed usage and response identity when a completion has invalid tool arguments", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-invalid-arguments",
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 100, completion_tokens: 30 },
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
          { id: "call-1", type: "function", function: { name: "read", arguments: "{broken" } },
        ] } }],
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "gpt-4o-mini", name: "test", api: "openai-completions", provider: "test", baseUrl,
        reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
      const stream = await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "Read", timestamp: 1 }],
      }, { apiKey: "unit-test-key", maxRetries: 0 });
      for await (const _event of stream) { /* Drain the rejected completion. */ }
      expect(await stream.result()).toMatchObject({
        stopReason: "error", responseId: "chatcmpl-invalid-arguments", responseModel: "gpt-4o-mini",
        usage: { input: 100, output: 30, totalTokens: 130 },
      });
    } finally {
      await close(server);
    }
  });

  it("bounds a hung attempt and retries it only within the configured budget", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-after-timeout",
        model: "gpt-4o-mini",
        choices: [{ finish_reason: "stop", message: { content: "Recovered." } }],
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
      const stream = await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      }, {
        apiKey: "unit-test-key",
        // This tests retry semantics, not sub-20ms socket scheduling under load.
        timeoutMs: 500,
        maxRetries: 1,
        maxRetryDelayMs: 1,
      });
      for await (const _event of stream) {
        // Drain both attempts.
      }
      const result = await stream.result();

      expect(attempts).toBe(2);
      expect(result).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered." }],
      });
    } finally {
      await close(server);
    }
  });

  it("does not turn a long provider Retry-After into an early retry", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "60",
      });
      response.end(JSON.stringify({ error: { message: "try later" } }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
      const stream = await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      }, {
        apiKey: "unit-test-key",
        maxRetries: 1,
        maxRetryDelayMs: 5,
      });
      for await (const _event of stream) {
        // Drain the terminal error.
      }
      const result = await stream.result();

      expect(attempts).toBe(1);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("exceeding the 5ms retry delay limit");
    } finally {
      await close(server);
    }
  });

  it("retries a transient provider response without changing Qwen thinking", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        Record<string, unknown>);
      if (payloads.length === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ error: { message: "temporary" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-retried",
        model: "Qwen/Qwen3-32B",
        choices: [{
          finish_reason: "stop",
          message: { content: "OK", reasoning_content: "Checked." },
        }],
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "Qwen/Qwen3-32B",
        name: "Qwen3 32B",
        api: "openai-completions",
        provider: "siliconflow",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 8_192,
        compat: {
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
          thinkingFormat: "qwen",
        },
      };
      const stream = await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      }, { apiKey: "test-key", reasoning: "high" });
      for await (const _event of stream) {
        // Drain the retried response.
      }
      const result = await stream.result();

      expect(result.stopReason).toBe("stop");
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toEqual(payloads[1]);
      expect(payloads.every((payload) => payload.enable_thinking === true))
        .toBe(true);
    } finally {
      await close(server);
    }
  });

  it("maps Pi thinking levels to Qwen enable_thinking", async () => {
    let requestPayload: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-qwen",
        model: "Qwen/Qwen3-32B",
        choices: [{
          finish_reason: "stop",
          message: { content: "OK", reasoning_content: "Checked." },
        }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "Qwen/Qwen3-32B",
        name: "Qwen3 32B",
        api: "openai-completions",
        provider: "siliconflow",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 8_192,
        compat: {
          maxTokensField: "max_tokens",
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          thinkingFormat: "qwen",
        },
      };
      const stream = await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      }, {
        apiKey: "test-key",
        reasoning: "high",
      });
      for await (const _event of stream) {
        // Drain the complete response so the request body can be inspected.
      }
      expect(requestPayload).toMatchObject({
        model: "Qwen/Qwen3-32B",
        stream: false,
        enable_thinking: true,
        max_tokens: 8_192,
      });
      expect(requestPayload).not.toHaveProperty("reasoning_effort");
    } finally {
      await close(server);
    }
  });

  it("maps complete tool calls and usage onto the Pi event protocol", async () => {
    let requestPayload: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-test",
        model: "gpt-4o-mini-2024-07-18",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Checking memory.",
              tool_calls: [
                {
                  id: "call-search",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: JSON.stringify({ queries: ["blue notebook"] }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { maxTokensField: "max_tokens" },
      };
      const context: Context = {
        systemPrompt: "Use tools.",
        messages: [
          {
            role: "user",
            content: "Find the notebook.",
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-old",
                name: "search",
                arguments: { queries: ["notebook"] },
              },
            ],
            api: "openai-completions",
            provider: "test-provider",
            model: "gpt-4o-mini",
            usage: {
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
            },
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call-old",
            toolName: "search",
            content: [{ type: "text", text: "Found one candidate." }],
            isError: false,
            timestamp: 3,
          },
        ],
        tools: [
          {
            name: "search",
            description: "Search memory",
            parameters: Type.Object({
              queries: Type.Array(Type.String()),
            }),
          },
        ],
      };

      const stream = await openAINonStreamingStreamFn(model, context, {
        apiKey: "unit-test-key",
        temperature: 0,
        maxTokens: 321,
      });
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();

      expect(authorization).toBe("Bearer unit-test-key");
      expect(requestPayload).toMatchObject({
        model: "gpt-4o-mini",
        stream: false,
        max_tokens: 321,
        temperature: 0,
        store: false,
      });
      expect(requestPayload).not.toHaveProperty("stream_options");
      expect(requestPayload?.messages).toEqual([
        { role: "system", content: "Use tools." },
        { role: "user", content: "Find the notebook." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-old",
              type: "function",
              function: {
                name: "search",
                arguments: JSON.stringify({ queries: ["notebook"] }),
              },
            },
          ],
        },
        {
          role: "tool",
          content: "Found one candidate.",
          tool_call_id: "call-old",
        },
      ]);
      expect(requestPayload?.tools).toEqual([
        {
          type: "function",
          function: {
            name: "search",
            description: "Search memory",
            parameters: Type.Object({
              queries: Type.Array(Type.String()),
            }),
            strict: false,
          },
        },
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(result).toMatchObject({
        responseId: "chatcmpl-test",
        responseModel: "gpt-4o-mini-2024-07-18",
        stopReason: "toolUse",
        usage: {
          input: 8,
          output: 3,
          cacheRead: 2,
          totalTokens: 13,
        },
        content: [
          { type: "text", text: "Checking memory." },
          {
            type: "toolCall",
            id: "call-search",
            name: "search",
            arguments: { queries: ["blue notebook"] },
          },
        ],
      });
    } finally {
      await close(server);
    }
  });

  it("fails closed when the provider substitutes the requested model", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-substituted",
        model: "gpt-4o-mini-fast",
        choices: [{ finish_reason: "stop", message: { content: "No." } }],
      }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
      const stream = await openAINonStreamingStreamFn(model, {
        systemPrompt: "Use memory.",
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
        tools: [],
      }, { apiKey: "unit-test-key" });
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();

      expect(events.at(-1)?.type).toBe("error");
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(
        "Provider substituted model gpt-4o-mini-fast; expected gpt-4o-mini",
      );
    } finally {
      await close(server);
    }
  });
});


describe("transport callback isolation", () => {
  it("does not retry a local callback failure and preserves completed usage", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "completed", model: "test", usage: {
        prompt_tokens: 10, completion_tokens: 5,
      }, choices: [{ finish_reason: "stop", message: { content: "OK" } }] }));
    });
    const baseUrl = await listen(server);
    try {
      const model: Model<"openai-completions"> = {
        id: "test", name: "test", api: "openai-completions", provider: "test", baseUrl,
        reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const result = await (await openAINonStreamingStreamFn(model, {
        messages: [{ role: "user", content: "test", timestamp: 1 }],
      }, { apiKey: "test", maxRetries: 2, maxRetryDelayMs: 1, timeoutMs: 5000,
        onResponse() { throw new Error("LOCAL_CALLBACK_FAILURE"); },
      })).result();
      expect(requests).toBe(1);
      expect(result).toMatchObject({ stopReason: "error", errorMessage: "LOCAL_CALLBACK_FAILURE",
        responseId: "completed", responseModel: "test", usage: { totalTokens: 15 } });
    } finally { server.closeAllConnections(); await close(server); }
  });
});
