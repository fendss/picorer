export const WORKING_MEMORY_MAX_CHARS = 1600;
export const WORKING_MEMORY_MAX_OPERATIONS = 16;

export interface WorkingMemoryEntry { id: string; text: string }
export type WorkingMemoryChange =
  | { op: "add"; id: string; after: string }
  | { op: "update"; id: string; before: string; after: string }
  | { op: "retire"; id: string; before: string; reason: string };
export interface WorkingMemoryCommit {
  toolCallId: string;
  revision: number;
  changes: WorkingMemoryChange[];
}
export interface WorkingMemorySnapshot {
  version: 2;
  revision: number;
  entries: WorkingMemoryEntry[];
  history: WorkingMemoryCommit[];
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workingMemory operations must be objects");
  }
  const input = value as Record<string, unknown>;
  const expected = input.op === "add" ? ["op", "text"]
    : input.op === "update" ? ["op", "id", "text"]
    : input.op === "retire" ? ["op", "id", "reason"] : [];
  if (!expected.length || Object.keys(input).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(input, key))) {
    throw new Error("workingMemory expects add with text, update with id and text, or retire with id and reason");
  }
  return input;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > WORKING_MEMORY_MAX_CHARS) {
    throw new Error(`workingMemory ${name} must contain 1-${WORKING_MEMORY_MAX_CHARS} characters`);
  }
  return value.trim();
}

/** Task-local entries. Every accepted patch is atomic; omitted entries survive. */
export class IncrementalWorkingMemory {
  private entries = new Map<string, WorkingMemoryEntry>();
  private history: WorkingMemoryCommit[] = [];
  private nextId = 1;
  private revision = 0;

  constructor(private readonly validateReferences: (text: string) => void) {}

  get initialized(): boolean { return this.revision > 0; }

  apply(delta: unknown, toolCallId: string): WorkingMemoryCommit {
    if (delta === null || (Array.isArray(delta) && delta.length === 0)) {
      return { toolCallId, revision: this.revision, changes: [] };
    }
    if (!Array.isArray(delta) || delta.length > WORKING_MEMORY_MAX_OPERATIONS) {
      throw new Error("workingMemory must be an incremental operation array, or null to keep it unchanged; whole-note replacement is not supported");
    }
    const staged = new Map(this.entries);
    const touched = new Set<string>();
    const changes: WorkingMemoryChange[] = [];
    let nextId = this.nextId;
    for (const value of delta) {
      const input = fields(value);
      if (input.op === "add") {
        const text = nonempty(input.text, "text");
        this.validateReferences(text);
        const id = `W${nextId++}`;
        staged.set(id, { id, text });
        changes.push({ op: "add", id, after: text });
        continue;
      }
      // Updates can only name entries already shown before this patch, not guess
      // IDs for entries being added in the same transaction.
      const id = typeof input.id === "string" ? input.id : "";
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown or retired workingMemory entry ${id}`);
      if (touched.has(id)) throw new Error(`workingMemory entry ${id} is changed twice in one patch`);
      touched.add(id);
      if (input.op === "update") {
        const text = nonempty(input.text, "text");
        this.validateReferences(text);
        staged.set(id, { id, text });
        changes.push({ op: "update", id, before: entry.text, after: text });
      } else {
        const reason = nonempty(input.reason, "retirement reason");
        staged.delete(id);
        changes.push({ op: "retire", id, before: entry.text, reason });
      }
    }
    const chars = [...staged.values()].reduce((sum, entry) => sum + entry.text.length, 0);
    if (chars > WORKING_MEMORY_MAX_CHARS) {
      throw new Error(`workingMemory active entries would use ${chars}/${WORKING_MEMORY_MAX_CHARS} characters. Nothing was changed or truncated; explicitly update or retire entries if appropriate.`);
    }
    const commit = { toolCallId, revision: this.revision + 1, changes };
    this.entries = staged;
    this.nextId = nextId;
    this.revision = commit.revision;
    this.history.push(commit);
    return structuredClone(commit);
  }

  render(): string {
    return `<WORKING_MEMORY revision="${this.revision}" authority="model-authored-note">\n` +
      ([...this.entries.values()].map((entry) => `${entry.id}: ${entry.text}`).join("\n") || "No active entries.") +
      "\n</WORKING_MEMORY>";
  }

  snapshot(): WorkingMemorySnapshot {
    return structuredClone({ version: 2, revision: this.revision,
      entries: [...this.entries.values()], history: this.history });
  }
}
