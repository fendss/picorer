import { describe, expect, it } from "vitest";
import {
  bm25Scores,
  reciprocalRankFusion,
  tokenizeForPicorerHybrid,
} from "../src/retrieval/ranking.js";

describe("Picorer hybrid ranking", () => {
  it("normalizes punctuation and case and removes NLTK English stopwords", () => {
    expect(tokenizeForPicorerHybrid("The QUICK, brown fox isn't in New_York."))
      .toEqual(["quick", "brown", "fox", "new_york"]);
    expect(tokenizeForPicorerHybrid("... THE and OF ...")).toEqual([]);
  });

  it("returns zero scores for empty corpora or queries without effective tokens", () => {
    expect(bm25Scores("anything", ["", "---"])).toEqual([0, 0]);
    expect(bm25Scores("the and", ["cat", "dog"])).toEqual([0, 0]);
  });

  it("uses candidate-local BM25 with the rank_bm25 epsilon IDF floor", () => {
    const scores = bm25Scores("common", ["common common", "common rare"]);
    expect(scores).toHaveLength(2);
    expect(scores[0]!).toBeLessThan(0);
    expect(scores[0]!).toBeLessThan(scores[1]!);
  });

  it("keeps score ties available for a caller's stable ordering", () => {
    expect(bm25Scores("missing", ["same text", "same text"])).toEqual([0, 0]);
  });

  it("fuses ranks from one and resolves conflicting rankings with k=60", () => {
    const scores = reciprocalRankFusion(
      [
        [0, 1, 2],
        [2, 1, 0],
      ],
      60,
      3,
    );
    expect(scores[0]).toBeCloseTo(1 / 61 + 1 / 63);
    expect(scores[1]).toBeCloseTo(2 / 62);
    expect(scores[2]).toBeCloseTo(1 / 63 + 1 / 61);
    expect(scores[0]).toBeCloseTo(scores[2]!);
  });

  it("rejects malformed rankings rather than silently double-counting", () => {
    expect(() => reciprocalRankFusion([[0, 0]], 60)).toThrow(/duplicate/u);
    expect(() => reciprocalRankFusion([[1]], -1)).toThrow(/non-negative/u);
  });
});
