import { WORKING_MEMORY_MAX_CHARS, WORKING_MEMORY_MAX_OPERATIONS } from "./working-memory.js";

export interface WorkSource { ref: string; quote: string }
export interface WorkDependency { id: string; version: number }
export interface WorkItem {
  id: string;
  version: number;
  question: string;
  choice: string;
  sources: WorkSource[];
  gap: string;
  dependsOn: WorkDependency[];
  stale: boolean;
}
export interface WorkChange { op: "add" | "update" | "retire" | "invalidate"; id: string; before?: WorkItem; after?: WorkItem; reason?: string }
export interface WorkCommit { toolCallId: string; revision: number; changes: WorkChange[] }
export interface WorkProgressSnapshot { version: 3; revision: number; entries: WorkItem[]; history: WorkCommit[] }
export interface WorkSources {
  validate(source: WorkSource): void;
  identity(source: WorkSource): string;
  delivered(source: WorkSource): boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("workingMemory expects objects");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > WORKING_MEMORY_MAX_CHARS) {
    throw Error(`Invalid workingMemory ${name}`);
  }
  return value.trim();
}
function array<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 12) throw Error("workingMemory list must contain at most 12 items");
  return value.map(parse);
}

/** Current decisions, not a log of searches. Prior revisions live only in audit. */
export class WorkProgress {
  private entries = new Map<string, WorkItem>();
  private history: WorkCommit[] = [];
  private revision = 0;
  private nextId = 1;
  constructor(private readonly sources: WorkSources) {}
  get initialized(): boolean { return this.revision > 0; }

  apply(delta: unknown, toolCallId: string): WorkCommit {
    if (delta == null || (Array.isArray(delta) && !delta.length)) return { toolCallId, revision: this.revision, changes: [] };
    if (!Array.isArray(delta) || delta.length > WORKING_MEMORY_MAX_OPERATIONS) throw Error("workingMemory expects local operation array or null");
    const staged = structuredClone(this.entries), touched = new Set<string>();
    const changes: WorkChange[] = [];
    let nextId = this.nextId;
    for (const raw of delta) {
      const value = object(raw), op = value.op;
      const allowed = op === "retire" ? ["op", "id", "reason"] : ["op", "id", "question", "choice", "sources", "gap", "dependsOn"];
      if (!["add", "update", "retire"].includes(String(op)) || Object.keys(value).some(k => !allowed.includes(k))) throw Error("Invalid workingMemory operation fields");
      if (op === "add" && value.id !== undefined) throw Error("New workingMemory IDs are assigned by the program");
      const id = op === "add" ? `W${nextId}` : text(value.id, "id");
      const before = this.entries.get(id);
      if (op !== "add" && !before) throw Error(`Unknown workingMemory item ${id}`);
      if (touched.has(id)) throw Error(`Duplicate workingMemory update ${id}`);
      touched.add(id);
      if (op === "retire") {
        const reason = text(value.reason, "retirement reason");
        staged.delete(id); changes.push({ op, id, before: before!, reason }); continue;
      }
      if (op === "update" && Object.keys(value).length <= 2) throw Error("Update must change at least one field");
      if (before?.stale && ["choice", "sources", "dependsOn"].some(k => value[k] === undefined)) {
        throw Error(`Recheck ${id}: explicitly supply choice, sources and current dependsOn before reusing a stale judgment`);
      }
      if (before && value.choice !== undefined && value.choice !== before.choice && value.sources === undefined) {
        throw Error("Changing a choice requires its sources in the same patch; [] means not yet supported");
      }
      const merged = { ...before, ...value };
      const item: WorkItem = { id, version: before?.version ?? 1,
        question: text(merged.question, "question"), choice: text(merged.choice, "choice", true),
        gap: text(merged.gap, "gap", true), stale: false,
        sources: array(merged.sources, raw => {
          const s = object(raw);
          if (Object.keys(s).some(k => !["ref", "quote"].includes(k))) throw Error("Invalid source fields");
          const source = { ref: text(s.ref, "source ref"), quote: text(s.quote, "source quote") };
          this.sources.validate(source); return source;
        }),
        dependsOn: array(merged.dependsOn, raw => {
          const d = object(raw), parent = this.entries.get(String(d.id));
          if (Object.keys(d).some(k => !["id", "version"].includes(k)) || !parent || parent.id === id || parent.stale || parent.version !== d.version) {
            throw Error(`Invalid or outdated dependency ${String(d.id)}; use a current W ID and its version`);
          }
          return { id: parent.id, version: parent.version };
        }),
      };
      // Compare parsed values, not the model's JSON key order. A repeated
      // identical add neither allocates a new ID nor changes the current task.
      if (op === "add") {
        const duplicate = [...staged.values()].some(e => !e.stale &&
          this.basis(e) === this.basis(item) && e.gap === item.gap);
        if (duplicate) { touched.delete(id); continue; }
        nextId++;
      }
      if (before && this.basis(before) !== this.basis(item)) item.version++;
      staged.set(id, item); changes.push({ op: op as "add" | "update", id, ...(before ? { before } : {}), after: item });
    }
    // Validate the declared graph, including updates that depend on each other.
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw Error("workingMemory dependencies must not contain a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const d of staged.get(id)?.dependsOn ?? []) if (staged.has(d.id)) visit(d.id);
      visiting.delete(id); visited.add(id);
    };
    for (const id of staged.keys()) visit(id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, item] of staged) {
        if (item.stale || !item.dependsOn.some(d => !staged.has(d.id) || staged.get(d.id)!.stale || staged.get(d.id)!.version !== d.version)) continue;
        const after = { ...item, stale: true };
        staged.set(id, after); changes.push({ op: "invalidate", id, before: item, after }); changed = true;
      }
    }
    const chars = [...staged.values()].reduce((n, e) => n + e.question.length + e.choice.length + e.gap.length + e.sources.reduce((m, s) => m + s.quote.length, 0), 0);
    if (staged.size > 12 || chars > WORKING_MEMORY_MAX_CHARS) throw Error(`workingMemory would use ${chars}/${WORKING_MEMORY_MAX_CHARS} text characters or exceed 12 tasks. Nothing changed. Shorten current task fields or explicitly retire irrelevant tasks; read and insufficient finish need no patch.`);
    if (!changes.length) return { toolCallId, revision: this.revision, changes: [] };
    const commit = structuredClone({ toolCallId, revision: this.revision + 1, changes });
    this.entries = staged; this.nextId = nextId; this.revision++; this.history.push(commit);
    return structuredClone(commit);
  }

  private basis(item: WorkItem): string {
    return JSON.stringify([item.question, item.choice,
      [...new Set(item.sources.map(s => this.sources.identity(s)))].sort(),
      [...new Set(item.dependsOn.map(d => JSON.stringify([d.id,d.version])))].sort(),
    ]);
  }

  gaps(): string[] {
    const entries = [...this.entries.values()];
    if (!entries.length) return ["No question progress recorded"];
    return entries.flatMap(e => [
      ...(e.stale ? [`${e.id}: upstream judgment changed; recheck this task`] : []),
      ...(e.gap ? [`${e.id}: ${e.gap}`] : []),
      ...(!e.choice ? [`${e.id}: no current choice`] : []),
      ...(!e.sources.length ? [`${e.id}: no declared supporting source`] : []),
      ...e.sources.filter(s => !this.sources.delivered(s)).map(s => `${e.id}: read ${s.ref}; required quote is absent from the source package`),
    ]);
  }
  assertFinish(status: unknown): void {
    if (status !== "sufficient") return;
    const gaps = this.gaps();
    if (gaps.length) throw Error(`Finish sufficient rejected: ${gaps.join("; ")}. Read missing sources, recheck tasks, or finish insufficient without a memory patch.`);
  }
  render(): string {
    return `<WORKING_MEMORY revision="${this.revision}" authority="model-authored-progress">
` +
      ([...this.entries.values()].map(e => JSON.stringify({ ...e, delivery: e.sources.map(s => ({ ref: s.ref, read: this.sources.delivered(s) })) })).join("\n") || "No tasks yet.") +
      "\nOpen checks: " + (this.gaps().join("; ") || "No declared gaps remain; decide whether the acquired sources are adequate for answering.") + "\n</WORKING_MEMORY>";
  }
  snapshot(): WorkProgressSnapshot {
    return structuredClone({ version: 3, revision: this.revision, entries: [...this.entries.values()], history: this.history });
  }
}
