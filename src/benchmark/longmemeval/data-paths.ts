import { join, resolve } from "node:path";

export interface LongMemEvalDataPaths {
  database: string;
  sanitized: string;
  privateQuestions: string;
}

export function dataPaths(dataDir: string): LongMemEvalDataPaths {
  const root = resolve(dataDir);
  return {
    database: join(root, "memory.sqlite"),
    sanitized: join(root, "sanitized"),
    privateQuestions: join(root, "private", "questions.jsonl"),
  };
}
