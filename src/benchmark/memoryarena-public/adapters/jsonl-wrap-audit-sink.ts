import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryArenaPublicError,
  type MemoryArenaWrapAuditRecord,
} from "../model/memory-backend.js";
import type { MemoryArenaWrapAuditSink } from "../ports/memory-backend.js";

export class JsonlMemoryArenaWrapAuditSink implements MemoryArenaWrapAuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  record(record: MemoryArenaWrapAuditRecord): Promise<void> {
    const envelope = {
      wrap_id: randomUUID(),
      created_at: new Date().toISOString(),
      ...record,
    };
    const operation = this.tail.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await appendFile(this.path, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(this.path, 0o600);
    });
    this.tail = operation.catch(() => undefined);
    return operation.catch((error: unknown) => {
      throw new MemoryArenaPublicError({
        code: "artifact_unavailable",
        message: "MemoryArena wrap audit could not be persisted",
        httpStatus: 503,
        retryable: true,
        cause: error,
      });
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

export class NoopMemoryArenaWrapAuditSink implements MemoryArenaWrapAuditSink {
  async record(_record: MemoryArenaWrapAuditRecord): Promise<void> {}
}
