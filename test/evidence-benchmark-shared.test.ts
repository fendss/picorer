import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceBenchmarkDataPaths,
} from "../src/benchmark/index.js";
import {
  mergeQuestionRecords,
  readQuestionRecords,
} from "../src/entrypoints/cli/private-records.js";
import { ingestEvidenceBenchmark } from "../src/benchmark/composition/ingest-evidence-benchmark.js";
import type { MemorySessionInput } from "../src/memory/index.js";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

interface TestPrivateQuestion {
  questionId: string;
  scopeId: string;
  question: string;
}

function memorySessions(): MemorySessionInput[] {
  return [
    {
      scopeId: "scope-a",
      sessionId: "scope-a-session-1",
      turns: [{
        id: "m-a00000000000000000000001",
        role: "user",
        content: "Alpha remembers a mango.",
      }],
    },
    {
      scopeId: "scope-a",
      sessionId: "scope-a-session-2",
      turns: [
        {
          id: "m-a00000000000000000000002",
          role: "assistant",
          content: "Beta recorded cobalt.",
        },
        {
          id: "m-a00000000000000000000003",
          role: "other",
          content: "Gamma noted a cedar tree.",
        },
      ],
    },
    {
      scopeId: "scope-b",
      sessionId: "scope-b-session-1",
      turns: [{
        id: "m-b00000000000000000000001",
        role: "system",
        content: "Delta stored obsidian.",
      }],
    },
  ];
}

describe("shared private benchmark store", () => {
  it("keys by questionId so multiple questions may share one scope", async () => {
    const root = await temporaryRoot("picorer-private-shared-");
    const path = join(root, "private", "questions.jsonl");
    const first: TestPrivateQuestion = {
      questionId: "question-2",
      scopeId: "shared-episode-scope",
      question: "What happened second?",
    };
    const second: TestPrivateQuestion = {
      questionId: "question-1",
      scopeId: "shared-episode-scope",
      question: "What happened first?",
    };

    await mergeQuestionRecords(path, [first]);
    await mergeQuestionRecords(path, [second, first]);

    expect(
      await readQuestionRecords<TestPrivateQuestion>(path),
    ).toEqual([second, first]);
    const serialized = await readFile(path, "utf8");
    expect(serialized.trim().split("\n")).toHaveLength(2);
    expect(serialized.match(/shared-episode-scope/gu)).toHaveLength(2);
  });

  it("keeps question identity immutable and protects private filesystem state", async () => {
    const root = await temporaryRoot("picorer-private-mode-");
    const path = join(root, "nested", "private", "questions.jsonl");
    const original: TestPrivateQuestion = {
      questionId: "question-1",
      scopeId: "scope-1",
      question: "Original private question",
    };
    await mergeQuestionRecords(path, [original]);

    const fileMode = (await stat(path)).mode & 0o777;
    const directoryMode = (await stat(dirname(path))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);

    await expect(mergeQuestionRecords(path, [{
      ...original,
      question: "Mutated private question",
    }])).rejects.toThrow(/changed for immutable question ID question-1/u);
    expect(
      await readQuestionRecords<TestPrivateQuestion>(path),
    ).toEqual([original]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("shared evidence benchmark ingest", () => {
  it("creates an empty lexical workspace without inventing memories", async () => {
    const root = await temporaryRoot("picorer-evidence-empty-");
    const paths = evidenceBenchmarkDataPaths(root);

    const result = await ingestEvidenceBenchmark({
      paths,
      sessions: [],
      retrievalProfile: "fts5",
    });

    expect(result).toEqual({
      scopes: [],
      retrieval: { retrievalProfile: "fts5" },
      embeddingIndexes: [],
    });
    await expect(stat(paths.database)).resolves.toBeDefined();
  });

  it("ingests multiple scopes and sessions through the lexical path", async () => {
    const root = await temporaryRoot("picorer-evidence-ingest-");
    const paths = evidenceBenchmarkDataPaths(root);

    const result = await ingestEvidenceBenchmark({
      paths,
      sessions: memorySessions(),
      retrievalProfile: "fts5",
    });

    expect(result.retrieval).toEqual({ retrievalProfile: "fts5" });
    expect(result.embeddingIndexes).toEqual([]);
    expect(result.scopes).toEqual([
      {
        scopeId: "scope-a",
        status: "inserted",
        memoryCount: 3,
        exportPath: expect.any(String),
      },
      {
        scopeId: "scope-b",
        status: "inserted",
        memoryCount: 1,
        exportPath: expect.any(String),
      },
    ]);
    expect(
      result.scopes.reduce((sum, scope) => sum + scope.memoryCount, 0),
    ).toBe(4);
    await expect(stat(paths.database)).resolves.toBeDefined();

    const manifests = await Promise.all(
      result.scopes.map(async (scope) =>
        JSON.parse(
          await readFile(join(scope.exportPath!, "manifest.json"), "utf8"),
        ) as unknown,
      ),
    );
    expect(manifests).toEqual([
      {
        schemaVersion: 1,
        scopeId: "scope-a",
        memoryCount: 3,
        sessions: ["scope-a-session-1", "scope-a-session-2"],
      },
      {
        schemaVersion: 1,
        scopeId: "scope-b",
        memoryCount: 1,
        sessions: ["scope-b-session-1"],
      },
    ]);

    const store = await MemoryStore.create(paths.database);
    try {
      expect(store.search("scope-a", {
        queries: ["mango cobalt"],
        limit: 10,
      }).map((hit) => hit.record.sessionId).sort()).toEqual([
        "scope-a-session-1",
        "scope-a-session-2",
      ]);
      expect(store.search("scope-b", {
        queries: ["obsidian"],
        limit: 10,
      })[0]?.record.content).toBe("Delta stored obsidian.");
    } finally {
      store.close();
    }
  });
});
