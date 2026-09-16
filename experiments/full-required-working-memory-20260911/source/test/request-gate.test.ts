import { describe, expect, it } from "vitest";
import { AsyncRequestGate } from "../src/platform/concurrency/request-gate.js";

describe("AsyncRequestGate", () => {
  it("bounds active operations", async () => {
    const gate = new AsyncRequestGate(3, 10_000);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 18 }, () =>
        gate.run(async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(3);
  });

  it("paces operation starts globally", async () => {
    const gate = new AsyncRequestGate(8, 50);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.run(async () => {
          starts.push(performance.now());
        }),
      ),
    );
    const intervals = starts.slice(1).map((start, index) => start - starts[index]!);
    expect(intervals.every((interval) => interval >= 14)).toBe(true);
  });

  it("releases a slot after an operation fails", async () => {
    const gate = new AsyncRequestGate(1, 10_000);
    await expect(
      gate.run(async () => {
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects invalid limits", () => {
    expect(() => new AsyncRequestGate(0, 1)).toThrow("positive integer");
    expect(() => new AsyncRequestGate(1, Number.NaN)).toThrow("positive and finite");
  });
});
