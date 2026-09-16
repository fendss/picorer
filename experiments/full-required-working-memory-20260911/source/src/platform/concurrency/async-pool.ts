export interface AsyncPoolContext {
  slot: number;
  index: number;
}

/** Refills free slots; on failure, stops dispatch and settles active work before rejecting. */
export async function runAsyncPool<T, R>(
  items: readonly T[],
  slots: number,
  worker: (item: T, context: AsyncPoolContext) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(slots) || slots <= 0) {
    throw new Error("Async pool slots must be a positive integer");
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const consume = async (slot: number): Promise<void> => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, { slot, index });
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };

  const workerCount = Math.min(slots, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, (_unused, index) => consume(index + 1)),
  );
  if (failed) throw failure;
  return results;
}
