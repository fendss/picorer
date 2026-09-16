import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { MemorySessionInput } from "../../memory/index.js";
import { sha256 } from "../../util.js";

/** Byte-exact identity of the public tau2-bench checkout used by Picorer. */
export const TAU_KNOWLEDGE_IDENTITY = Object.freeze({
  benchmark: "tau-knowledge",
  domain: "banking_knowledge",
  upstreamRepository: "https://github.com/sierra-research/tau2-bench.git",
  upstreamRevision: "a2c024725189473d2d7cea3a5cfdbcc67478e41f",
  upstreamVersion: "1.0.1",
  paper: "ICML 2026 / arXiv:2603.04370v1",
  documentsRelativePath: "data/tau2/domains/banking_knowledge/documents",
  tasksRelativePath: "data/tau2/domains/banking_knowledge/tasks",
  documentCount: 698,
  taskCount: 97,
  documentsSha256: "f9a2bfe1514069bebeef1209a0f4b64553912d40345e5f3c6d4dc34d1b0327a2",
  tasksSha256: "cc907bb927c6e29dc4661c58c89ff2680c81f8314367125127ab600619d25e4c",
} as const);

const TAU_SCOPE_NAMESPACE =
  `${TAU_KNOWLEDGE_IDENTITY.domain}@${TAU_KNOWLEDGE_IDENTITY.upstreamRevision}`;

export const TAU_KNOWLEDGE_SCOPE_ID =
  `tau-k-${sha256(TAU_SCOPE_NAMESPACE).slice(0, 20)}`;

interface JsonObject {
  [key: string]: unknown;
}

export interface TauKnowledgeDocument {
  id: string;
  title: string;
  content: string;
}

export interface TauKnowledgeDataset {
  identity: typeof TAU_KNOWLEDGE_IDENTITY;
  scopeId: string;
  documentsHash: string;
  tasksHash: string;
  sessions: MemorySessionInput[];
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonObject;
}

function sourceTextAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function safeDocumentId(value: unknown, path: string): string {
  const id = sourceTextAt(value, path).trim();
  if (!/^doc_[a-z0-9_()+\-.]+$/u.test(id)) {
    throw new TypeError(`${path} is not a canonical tau-Knowledge document ID`);
  }
  return id;
}

export function parseTauKnowledgeDocument(
  value: unknown,
  path = "document",
): TauKnowledgeDocument {
  const document = objectAt(value, path);
  return {
    id: safeDocumentId(document["id"], `${path}.id`),
    title: sourceTextAt(document["title"], `${path}.title`).trim(),
    content: sourceTextAt(document["content"], `${path}.content`),
  };
}

/**
 * Trusted ingest firewall. Only public document ID, title, and content cross
 * into Picorer; task gold documents and evaluator state are never read here.
 */
export function adaptTauKnowledgeDocuments(
  documents: readonly TauKnowledgeDocument[],
): MemorySessionInput[] {
  const seen = new Set<string>();
  return [...documents]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((document) => {
      if (seen.has(document.id)) {
        throw new Error(`Duplicate tau-Knowledge document ID: ${document.id}`);
      }
      seen.add(document.id);
      return {
        scopeId: TAU_KNOWLEDGE_SCOPE_ID,
        sessionId: document.id,
        turns: [{
          id: `m-${sha256(`${TAU_SCOPE_NAMESPACE}\0${document.id}`).slice(0, 24)}`,
          role: "other" as const,
          content: `# ${document.title}\n\n${document.content}`,
          metadata: {
            documentId: document.id,
            title: document.title,
          },
        }],
        metadata: {
          source: "tau-knowledge-document",
        },
      };
    });
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Hashes path and bytes in lexical path order; filenames are part of identity. */
export async function hashTauKnowledgeFiles(
  domainRoot: string,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(portableRelative(domainRoot, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function jsonFiles(directory: string, pattern: RegExp): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export async function loadPinnedTauKnowledgeCheckout(
  tauRoot: string,
): Promise<TauKnowledgeDataset> {
  const root = resolve(tauRoot);
  const domainRoot = join(root, "data/tau2/domains/banking_knowledge");
  const documentsDirectory = join(domainRoot, "documents");
  const tasksDirectory = join(domainRoot, "tasks");
  const [documentPaths, taskPaths] = await Promise.all([
    jsonFiles(documentsDirectory, /^doc_.+\.json$/u),
    jsonFiles(tasksDirectory, /^task_.+\.json$/u),
  ]);
  if (documentPaths.length !== TAU_KNOWLEDGE_IDENTITY.documentCount) {
    throw new Error(
      `tau-Knowledge document count mismatch: expected ` +
        `${TAU_KNOWLEDGE_IDENTITY.documentCount}, got ${documentPaths.length}`,
    );
  }
  if (taskPaths.length !== TAU_KNOWLEDGE_IDENTITY.taskCount) {
    throw new Error(
      `tau-Knowledge task count mismatch: expected ` +
        `${TAU_KNOWLEDGE_IDENTITY.taskCount}, got ${taskPaths.length}`,
    );
  }
  const [documentsHash, tasksHash] = await Promise.all([
    hashTauKnowledgeFiles(domainRoot, documentPaths),
    hashTauKnowledgeFiles(domainRoot, taskPaths),
  ]);
  if (documentsHash !== TAU_KNOWLEDGE_IDENTITY.documentsSha256) {
    throw new Error(
      `tau-Knowledge document corpus hash mismatch: expected ` +
        `${TAU_KNOWLEDGE_IDENTITY.documentsSha256}, got ${documentsHash}`,
    );
  }
  if (tasksHash !== TAU_KNOWLEDGE_IDENTITY.tasksSha256) {
    throw new Error(
      `tau-Knowledge task hash mismatch: expected ` +
        `${TAU_KNOWLEDGE_IDENTITY.tasksSha256}, got ${tasksHash}`,
    );
  }
  const documents = await Promise.all(documentPaths.map(async (path) =>
    parseTauKnowledgeDocument(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      portableRelative(root, path),
    )
  ));
  return {
    identity: TAU_KNOWLEDGE_IDENTITY,
    scopeId: TAU_KNOWLEDGE_SCOPE_ID,
    documentsHash,
    tasksHash,
    sessions: adaptTauKnowledgeDocuments(documents),
  };
}
