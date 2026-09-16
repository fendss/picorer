import { appendFile } from "node:fs/promises";

/** Serializes large JSONL appends so concurrent workers cannot interleave lines. */
export class JsonlWriter {
  private tail: Promise<void> = Promise.resolve();

  append(path: string, value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const operation = this.tail.then(() =>
      appendFile(path, line, { encoding: "utf8", mode: 0o600 }),
    );
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
