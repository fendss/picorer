import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MemoryStore } from "../src/platform/sqlite/picorer-store.js";
import { sha256 } from "../src/util.js";

it("lazily builds v2 facts beside v1 without altering raw memories or old facts", () => {
  const root = mkdtempSync(join(tmpdir(), "picorer-facts-migration-"));
  const path = join(root, "memory.sqlite");
  const store = new MemoryStore(path);
  const db = new DatabaseSync(path);
  try {
    const content = "balance -5 dollars";
    store.ingestScope("scope", [{ memoryId: "source", scopeId: "scope", sessionId: "session",
      turnIndex: 0, role: "user", content, contentHash: sha256(content), metadata: {} }]);
    const expand = () => store.expandEvidenceOperator("scope", { queries: ["balance"] },
      { operator: "numeric", maxCandidates: 10 }, []);
    expand();
    // Simulate a persisted v1 sidecar, including its unsigned-number defect.
    for (const table of ["memory_evidence_fact_index", "memory_numeric_facts", "memory_temporal_facts"]) {
      db.prepare(`UPDATE ${table} SET extractor_version = ?`).run("picorer-evidence-facts-v1");
    }
    db.exec("UPDATE memory_numeric_facts SET numeric_value = 5");
    const oldFacts = db.prepare("SELECT * FROM memory_numeric_facts WHERE extractor_version = ?")
      .all("picorer-evidence-facts-v1");
    const raw = db.prepare("SELECT * FROM memories").all();
    expect(expand()).toHaveLength(1);
    expect(db.prepare("SELECT numeric_value FROM memory_numeric_facts WHERE extractor_version = ?")
      .get("picorer-evidence-facts-v2")).toMatchObject({ numeric_value: -5 });
    expect(db.prepare("SELECT * FROM memory_numeric_facts WHERE extractor_version = ?")
      .all("picorer-evidence-facts-v1")).toEqual(oldFacts);
    expect(db.prepare("SELECT * FROM memories").all()).toEqual(raw);
    expand();
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_numeric_facts").get()).toMatchObject({ count: 2 });
  } finally {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
