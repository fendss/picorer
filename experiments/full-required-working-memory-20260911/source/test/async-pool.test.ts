import { describe, expect, it } from "vitest";
import { runAsyncPool } from "../src/platform/concurrency/async-pool.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runAsyncPool", () => {
  it("never exceeds the requested concurrency and preserves result order", async () => {
    let active = 0;
    let maximum = 0;
    const results = await runAsyncPool([30, 5, 20, 1], 2, async (delay) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return delay * 2;
    });

    expect(maximum).toBe(2);
    expect(results).toEqual([60, 10, 40, 2]);
  });

  it("refills a free slot without waiting for the other slots", async () => {
    const first = deferred();
    const second = deferred();
    const started: number[] = [];
    const running = runAsyncPool([0, 1, 2], 2, async (item) => {
      started.push(item);
      if (item === 0) await first.promise;
      if (item === 1) await second.promise;
      return item;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    second.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    first.resolve();
    await expect(running).resolves.toEqual([0, 1, 2]);
  });

  it("rejects invalid slot counts", async () => {
    await expect(runAsyncPool([1], 0, async (item) => item)).rejects.toThrow(
      "positive integer",
    );
  });

  it("stops dispatch after a failure and waits for active workers before rejecting", async () => {
    const release = deferred();
    const failure = new Error("worker failed");
    const started: number[] = [];
    let settled = false;
    let activeFinished = false;
    const running = runAsyncPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await release.promise;
      activeFinished = true;
      return item;
    });
    const outcome = running.then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeRelease = settled;
    release.resolve();
    expect(await outcome).toBe(failure);
    expect(settledBeforeRelease).toBe(false);
    expect(activeFinished).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});
