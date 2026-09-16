import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adaptTauKnowledgeDocuments,
  hashTauKnowledgeFiles,
  parseTauKnowledgeDocument,
  TAU_KNOWLEDGE_IDENTITY,
  TAU_KNOWLEDGE_SCOPE_ID,
} from "../src/benchmark/tau-knowledge/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("tau-Knowledge pinned dataset adapter", () => {
  it("whitelists public document fields into one immutable corpus scope", () => {
    const document = parseTauKnowledgeDocument({
      id: "doc_cards_blue_001",
      title: "Blue card policy",
      content: "The daily limit is $300.",
      required_documents: ["gold-secret"],
      evaluator_state: { answer: "hidden" },
    });
    const sessions = adaptTauKnowledgeDocuments([document]);

    expect(sessions).toEqual([{
      scopeId: TAU_KNOWLEDGE_SCOPE_ID,
      sessionId: document.id,
      turns: [{
        id: expect.stringMatching(/^m-[a-f0-9]{24}$/u),
        role: "other",
        content: "# Blue card policy\n\nThe daily limit is $300.",
        metadata: {
          documentId: document.id,
          title: document.title,
        },
      }],
      metadata: { source: "tau-knowledge-document" },
    }]);
    expect(JSON.stringify(sessions)).not.toContain("gold-secret");
    expect(JSON.stringify(sessions)).not.toContain("hidden");
  });

  it("rejects duplicate and malformed public documents", () => {
    const document = {
      id: "doc_cards_blue_001",
      title: "Blue card policy",
      content: "Policy text",
    };
    expect(() => adaptTauKnowledgeDocuments([document, document])).toThrow(
      "Duplicate tau-Knowledge document ID",
    );
    expect(() => parseTauKnowledgeDocument({
      id: "../../tasks/task_001",
      title: "Bad",
      content: "Bad",
    })).toThrow("canonical tau-Knowledge document ID");
  });

  it("binds lexical file paths and exact bytes into the corpus identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "picorer-tau-hash-"));
    temporaryDirectories.push(root);
    const documents = join(root, "documents");
    await mkdir(documents);
    const first = join(documents, "doc_a.json");
    const second = join(documents, "doc_b.json");
    await writeFile(first, "A", "utf8");
    await writeFile(second, "B", "utf8");

    const original = await hashTauKnowledgeFiles(root, [second, first]);
    await writeFile(second, "B changed", "utf8");
    const changed = await hashTauKnowledgeFiles(root, [first, second]);

    expect(original).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed).not.toBe(original);
    expect(TAU_KNOWLEDGE_IDENTITY).toMatchObject({
      documentCount: 698,
      taskCount: 97,
      upstreamVersion: "1.0.1",
    });
  });
});
