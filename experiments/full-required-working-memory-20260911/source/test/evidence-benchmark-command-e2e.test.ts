import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evidenceBenchmarkDataPaths,
  type EvidenceBenchmarkPrediction,
} from "../src/benchmark/index.js";
import type {
  AmaBenchPrivateLabel,
  AmaBenchPrivateQuery,
} from "../src/benchmark/amabench/index.js";
import { ingestEvidenceBenchmark } from "../src/benchmark/composition/ingest-evidence-benchmark.js";
import { benchmarkEvidence } from "../src/entrypoints/cli/commands/benchmark-evidence.js";
import { evaluateBenchmark } from "../src/entrypoints/cli/commands/evaluate-benchmark.js";
import { parseCommand } from "../src/entrypoints/cli/parse-command.js";
import { mergeQuestionRecords } from "../src/entrypoints/cli/private-records.js";
import { safePathSegment } from "../src/util.js";

type JsonObject = Record<string, unknown>;

interface MockRequest {
  stage: "search" | "read" | "finish" | "answer" | "judge";
  path: string;
  authorization: string | undefined;
  payload: JsonObject;
}

interface RetrievalTraceArtifact {
  case_id: string;
  retrieval: {
    citations: Array<{ memoryId: string }>;
    evidence: Array<{ memoryId: string }>;
    candidates: Array<{
      memoryId: string;
      inspected: boolean;
      committed: boolean;
    }>;
    trace: Array<{
      toolName: string;
      isError: boolean;
      details?: {
        evidence?: Array<{ memoryId: string }>;
      };
    }>;
    metrics: {
      searchCalls: number;
      readCalls: number;
      inspectedEvidenceCount: number;
      evidenceCount: number;
      citedCount: number;
    };
  };
  answer: { answer: string };
}

interface RunManifestArtifact {
  schema_version: number;
  config: {
    benchmark: string;
    selected_case_count: number;
    query_set_hash: string;
    corpus_hash: string;
    retrieval_model: { transport: string; api: string };
    answer_model: { transport: string; api: string };
    limits: { max_run_ms: number };
  };
}

interface ScoreArtifact {
  schema_version: number;
  benchmark: string;
  judge_model: { transport: string; api: string };
  aggregate: {
    overall: { count: number; avgScore: number; accuracy: number };
  };
  results: Array<{
    questionId: string;
    decision: string;
    score: number;
    fallback: { used: boolean };
  }>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "picorer-benchmark-e2e-"));
  temporaryDirectories.push(path);
  return path;
}

function objectAt(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

async function requestBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return objectAt(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    "request body",
  );
}

function priorToolNames(payload: JsonObject): Set<string> {
  const names = new Set<string>();
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return names;
  for (const rawMessage of messages) {
    const message = objectAt(rawMessage, "message");
    if (message["role"] !== "assistant") continue;
    const calls = message["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const rawCall of calls) {
      const call = objectAt(rawCall, "tool call");
      const fn = objectAt(call["function"], "tool call function");
      if (typeof fn["name"] === "string") names.add(fn["name"]);
    }
  }
  return names;
}

function toolResponse(
  id: string,
  name: string,
  args: JsonObject,
): JsonObject {
  return {
    finish_reason: "tool_calls",
    message: {
      content: null,
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  };
}

function scriptedChoice(payload: JsonObject): {
  stage: MockRequest["stage"];
  choice: JsonObject;
} {
  if (Array.isArray(payload["tools"])) {
    const prior = priorToolNames(payload);
    if (!prior.has("search")) {
      return {
        stage: "search",
        choice: toolResponse("call-search", "search", {
          operator: "lexical",
          queries: ["blue key chest"],
          limit: 5,
        }),
      };
    }
    if (!prior.has("read")) {
      return {
        stage: "read",
        choice: toolResponse("call-read", "read", {
          candidateRefs: ["C1"],
          contextBefore: 0,
          contextAfter: 0,
        }),
      };
    }
    return {
      stage: "finish",
      choice: toolResponse("call-finish", "finish", {
        status: "sufficient",
        evidenceSummary: "The exact source states that the chest contains a blue key.",
      }),
    };
  }

  const serialized = JSON.stringify(payload);
  if (serialized.includes("Reference Answer:")) {
    return {
      stage: "judge",
      choice: {
        finish_reason: "stop",
        message: { content: "yes" },
      },
    };
  }
  return {
    stage: "answer",
    choice: {
      finish_reason: "stop",
      message: { content: "A blue key." },
    },
  };
}

async function startMockProvider(): Promise<{
  server: Server;
  baseUrl: string;
  requests: MockRequest[];
  errors: Error[];
  returnEmptyAnswers: () => void;
}> {
  const requests: MockRequest[] = [];
  const errors: Error[] = [];
  let responseIndex = 0;
  let emptyAnswers = false;
  const server = createServer(async (request, response) => {
    try {
      const payload = await requestBody(request);
      const scripted = scriptedChoice(payload);
      if (emptyAnswers && scripted.stage === "answer") {
        scripted.choice.message = { content: "" };
      }
      requests.push({
        stage: scripted.stage,
        path: request.url ?? "",
        authorization: request.headers.authorization,
        payload,
      });
      responseIndex += 1;
      response.writeHead(200, {
        "connection": "close",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({
        id: `chatcmpl-e2e-${responseIndex}`,
        model: payload["model"],
        choices: [scripted.choice],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      errors.push(normalized);
      response.writeHead(500, {
        "connection": "close",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: { message: normalized.message } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock provider did not expose a TCP port");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    returnEmptyAnswers: () => { emptyAnswers = true; },
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function createAgentDirectory(
  root: string,
  baseUrl: string,
): Promise<string> {
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      defaultThinkingLevel: "off",
    }), "utf8"),
    writeFile(join(agentDirectory, "models.json"), JSON.stringify({
      providers: {
        "mock-provider": {
          baseUrl,
          api: "openai-completions",
          apiKey: "!printf 'offline-test-key'",
          compat: { maxTokensField: "max_tokens" },
          models: [{
            id: "mock-model",
            name: "Mock model",
            reasoning: false,
            input: ["text"],
            contextWindow: 32_000,
            maxTokens: 4_096,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }],
        },
      },
    }), "utf8"),
  ]);
  return agentDirectory;
}

function parseJsonLine<T>(serialized: string): T {
  const lines = serialized.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Expected one JSONL record, received ${lines.length}`);
  }
  return JSON.parse(lines[0]!) as T;
}

describe("evidence benchmark command offline workflow", () => {
  it("runs AMA search, read, finish, answer, then joins labels only for judging", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "data");
    const outputDirectory = join(root, "run");
    const scorePath = join(root, "scores.json");
    const paths = evidenceBenchmarkDataPaths(dataDirectory);
    const scopeId = "ama-focused-scope";
    const questionId = "11111111-1111-4111-8111-111111111111";
    const memoryId = "memory-blue-key";
    const query: AmaBenchPrivateQuery = {
      scopeId,
      episodeId: 7,
      questionId,
      questionIndex: 0,
      question: "What did the agent find inside the chest?",
    };
    const judgeOnlyMarker = "judge-only-secret-task-description";
    const label: AmaBenchPrivateLabel = {
      scopeId,
      episodeId: 7,
      questionId,
      questionIndex: 0,
      referenceAnswer: "A blue key.",
      capability: "B",
      taskDescription: judgeOnlyMarker,
      taskType: "webarena",
      domain: "WEB",
    };
    await ingestEvidenceBenchmark({
      paths,
      retrievalProfile: "fts5",
      sessions: [{
        scopeId,
        sessionId: "trajectory-1",
        turns: [{
          id: memoryId,
          role: "other",
          content: [
            "Step 0:",
            "Action: inspect the chest",
            "Observation: The agent found a blue key inside the chest.",
          ].join("\n"),
        }],
      }],
    });
    await mergeQuestionRecords(paths.privateQueries, [query]);
    await writeFile(paths.datasetManifest, `${JSON.stringify({
      schema_version: 1,
      identity: {
        benchmark: "ama-bench",
        split: "focused-offline",
        track: "official-open-ended",
        source: { revision: "offline-fixture-v1" },
      },
      retrieval: { retrievalProfile: "fts5" },
      case_count: 1,
    }, null, 2)}\n`, "utf8");

    await expect(access(paths.privateLabels)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(paths.database)).isFile()).toBe(true);
    const sanitized = await readFile(
      join(paths.sanitized, safePathSegment(scopeId), "memory.jsonl"),
      "utf8",
    );
    expect(sanitized).toContain("blue key inside the chest");
    expect(sanitized).not.toContain(judgeOnlyMarker);

    const provider = await startMockProvider();
    const agentDirectory = await createAgentDirectory(root, provider.baseUrl);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await benchmarkEvidence(parseCommand([
        "benchmark",
        "--benchmark", "ama-bench",
        "--data-dir", dataDirectory,
        "--output-dir", outputDirectory,
        "--slots", "1",
        "--stage-timeout-ms", "900000",
        "--skill", "picorer-v0",
        "--agent-dir", agentDirectory,
        "--transport", "non-stream",
      ]));

      expect(process.exitCode).toBeUndefined();
      expect(provider.requests.map((request) => request.stage)).toEqual([
        "search",
        "read",
        "finish",
        "answer",
      ]);
      expect(provider.requests.every((request) =>
        request.path === "/v1/chat/completions" &&
        request.authorization === "Bearer offline-test-key"
      )).toBe(true);
      expect(provider.requests.every((request) =>
        !JSON.stringify(request.payload).includes(judgeOnlyMarker)
      )).toBe(true);
      await expect(access(paths.privateLabels)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const prediction = parseJsonLine<EvidenceBenchmarkPrediction>(
        await readFile(join(outputDirectory, "predictions.jsonl"), "utf8"),
      );
      expect(prediction).toMatchObject({
        benchmark: "ama-bench",
        case_id: questionId,
        scope_id: scopeId,
        retrieval_status: "sufficient",
        abstention: false,
        response: { kind: "text", text: "A blue key." },
        citations: [{ memoryId }],
      });

      const trace = parseJsonLine<RetrievalTraceArtifact>(
        await readFile(join(outputDirectory, "traces.jsonl"), "utf8"),
      );
      expect(trace.case_id).toBe(questionId);
      expect(trace.answer.answer).toBe("A blue key.");
      expect(trace.retrieval.trace.map((item) => item.toolName)).toEqual([
        "search",
        "read",
        "finish",
      ]);
      expect(trace.retrieval.trace.every((item) => !item.isError)).toBe(true);
      expect(trace.retrieval.metrics).toMatchObject({
        searchCalls: 1,
        readCalls: 1,
        inspectedEvidenceCount: 1,
        evidenceCount: 1,
        citedCount: 1,
      });
      const citedIds = trace.retrieval.citations.map((item) => item.memoryId);
      const evidenceIds = new Set(
        trace.retrieval.evidence.map((item) => item.memoryId),
      );
      const inspectedIds = new Set(
        trace.retrieval.trace
          .filter((item) => item.toolName === "read")
          .flatMap((item) => item.details?.evidence ?? [])
          .map((item) => item.memoryId),
      );
      expect(citedIds).toEqual([memoryId]);
      expect(citedIds.every((id) => evidenceIds.has(id) && inspectedIds.has(id)))
        .toBe(true);
      expect(trace.retrieval.candidates).toEqual([
        expect.objectContaining({ memoryId, inspected: true, committed: true }),
      ]);

      const manifest = JSON.parse(
        await readFile(join(outputDirectory, "run-manifest.json"), "utf8"),
      ) as RunManifestArtifact;
      expect(manifest).toMatchObject({
        schema_version: 1,
        config: {
          benchmark: "ama-bench",
          selected_case_count: 1,
          retrieval_model: {
            transport: "non-stream",
            api: "openai-completions",
          },
          answer_model: {
            transport: "non-stream",
            api: "openai-completions",
          },
          limits: { max_run_ms: 900000 },
        },
      });
      expect(manifest.config.query_set_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.config.corpus_hash).toMatch(/^[a-f0-9]{64}$/u);

      await mergeQuestionRecords(paths.privateLabels, [label]);
      await evaluateBenchmark(parseCommand([
        "evaluate-benchmark",
        "--benchmark", "ama-bench",
        "--data-dir", dataDirectory,
        "--predictions", join(outputDirectory, "predictions.jsonl"),
        "--output", scorePath,
        "--slots", "1",
        "--stage-timeout-ms", "900000",
        "--agent-dir", agentDirectory,
        "--transport", "non-stream",
      ]));

      expect(provider.requests.map((request) => request.stage)).toEqual([
        "search",
        "read",
        "finish",
        "answer",
        "judge",
      ]);
      expect(JSON.stringify(provider.requests.at(-1)?.payload))
        .toContain(judgeOnlyMarker);
      const score = JSON.parse(await readFile(scorePath, "utf8")) as ScoreArtifact;
      expect(score).toMatchObject({
        schema_version: 1,
        benchmark: "ama-bench",
        judge_model: {
          transport: "non-stream",
          api: "openai-completions",
        },
        aggregate: {
          overall: { count: 1, avgScore: 1, accuracy: 1 },
        },
        results: [{
          questionId,
          decision: "yes",
          score: 1,
          fallback: { used: false },
        }],
      });
      await expect(access(`${scorePath}.manifest.json`)).resolves.toBeUndefined();
      const evaluationManifest = JSON.parse(
        await readFile(`${scorePath}.manifest.json`, "utf8"),
      ) as { config: { stage_timeout_ms: number } };
      expect(evaluationManifest.config.stage_timeout_ms).toBe(900000);
      await expect(access(join(
        `${scorePath}.judge-records`,
        `${safePathSegment(questionId)}.json`,
      ))).resolves.toBeUndefined();
      expect(provider.errors).toEqual([]);

      // The persisted failure must retain work already billed by both stages.
      provider.returnEmptyAnswers();
      const failedOutput = join(root, "failed-answer-run");
      await benchmarkEvidence(parseCommand([
        "benchmark", "--benchmark", "ama-bench",
        "--data-dir", dataDirectory, "--output-dir", failedOutput,
        "--slots", "1", "--skill", "picorer-v0",
        "--agent-dir", agentDirectory, "--transport", "non-stream",
      ]));
      expect(process.exitCode).toBe(1);
      const failed = parseJsonLine<JsonObject>(
        await readFile(join(failedOutput, "failures.jsonl"), "utf8"),
      );
      expect(failed).toMatchObject({
        case_id: questionId,
        error: "Benchmark answer stage returned empty text",
        retrieval: {
          evidence: [{ memoryId }],
          usage: { input: 30, output: 9, totalTokens: 39 },
        },
        answerDiagnostics: { usage: { input: 10, output: 3, totalTokens: 13 } },
      });
      expect(JSON.parse(await readFile(join(
        failedOutput, "failure-records", `${safePathSegment(questionId)}.json`,
      ), "utf8"))).toEqual(failed);
      expect(provider.errors).toEqual([]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode;
      await closeServer(provider.server);
    }
  });
});
