import { WORKING_MEMORY_MAX_CHARS } from "./working-memory.js";

export interface RewriteMemorySnapshot {
  version: 1;
  revision: number;
  note: string | null;
  history: { toolCallId: string; revision: number; before: string | null; after: string }[];
}

/** One replaceable note; prior revisions are audit data, never model context. */
export class RewriteWorkingMemory {
  private state: RewriteMemorySnapshot = { version: 1, revision: 0, note: null, history: [] };

  constructor(private readonly validateReferences: (text: string) => void) {}

  get initialized(): boolean { return this.state.note !== null; }

  apply(value: unknown, toolCallId: string) {
    let mode: "replace" | "unchanged" = "unchanged";
    if (value !== null && value !== undefined) {
      if (typeof value !== "string" || !value.trim() || value.trim().length > WORKING_MEMORY_MAX_CHARS) {
        throw new Error(`workingMemory must be a nonempty replacement note of at most ${WORKING_MEMORY_MAX_CHARS} characters, or null to keep it unchanged.`);
      }
      const next = value.trim();
      this.validateReferences(next);
      if (next !== this.state.note) {
        this.state.history.push({ toolCallId, revision: ++this.state.revision, before: this.state.note, after: next });
        this.state.note = next;
        mode = "replace";
      }
    }
    return { toolCallId, revision: this.state.revision, mode, note: this.state.note };
  }

  render(): string {
    return `<WORKING_MEMORY revision="${this.state.revision}" authority="model-authored-note">\n` +
      (this.state.note ?? "No working note yet.") + "\n</WORKING_MEMORY>";
  }

  snapshot(): RewriteMemorySnapshot { return structuredClone(this.state); }
}
