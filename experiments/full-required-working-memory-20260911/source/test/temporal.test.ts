import { describe, expect, it } from "vitest";
import { temporalAnnotation } from "../src/retrieval/index.js";

describe("temporal annotations", () => {
  it("relates timezone-free source timestamps to the question date", () => {
    expect(
      temporalAnnotation(
        "2023-05-28T19:00:00",
        "2023/05/30 (Tue) 21:00",
      ),
    ).toBe("weekday=Sun; 2 days 2 hours before question");
  });

  it("returns a weekday without inventing a relation for unknown question dates", () => {
    expect(temporalAnnotation("2023-05-30T19:00:00", undefined)).toBe(
      "weekday=Tue",
    );
    expect(temporalAnnotation(undefined, "2023/05/30 (Tue) 21:00")).toBeUndefined();
  });
});
