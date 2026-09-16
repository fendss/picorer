export function uniqueCandidateRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}
