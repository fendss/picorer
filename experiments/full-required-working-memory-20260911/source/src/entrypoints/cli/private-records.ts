import {
  mergePrivateJsonl,
  readPrivateJsonl,
} from "../../platform/filesystem/private-jsonl.js";

export function readQuestionRecords<T extends { questionId: string }>(
  path: string,
): Promise<T[]> {
  return readPrivateJsonl<T>(path);
}

export function mergeQuestionRecords<T extends { questionId: string }>(
  path: string,
  records: readonly T[],
): Promise<void> {
  return mergePrivateJsonl(path, records, {
    label: "question ID",
    key: (record) => record.questionId,
  });
}

export function readScopeRecords<T extends { scopeId: string }>(
  path: string,
): Promise<T[]> {
  return readPrivateJsonl<T>(path);
}

export function mergeScopeRecords<T extends { scopeId: string }>(
  path: string,
  records: readonly T[],
): Promise<void> {
  return mergePrivateJsonl(path, records, {
    label: "scope ID",
    key: (record) => record.scopeId,
  });
}
