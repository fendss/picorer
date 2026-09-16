import { describe, expect, it } from "vitest";
import {
  LONGMEMEVAL_ANSWER_PROMPT_TEMPLATE,
  LONGMEMEVAL_ANSWER_PROMPT_VERSION,
  adaptLongMemEvalS,
  buildLongMemEvalAnswerPrompt,
  longMemEvalMemoryId,
  longMemEvalScopeId,
  longMemEvalSessionId,
  normalizeLongMemEvalTimestamp,
} from "../src/benchmark/longmemeval/dataset-adapter.js";
import type { PicorerResult } from "../src/evidence-agent/index.js";
import { sha256 } from "../src/util.js";

function mixedFixture(): unknown {
  return [
    {
      conversation: {
        speaker_a: "user",
        speaker_b: "assistant",
        session_10_date_time: "2023/05/20 (Sat) 03:51",
        session_10: [
          {
            dia_id: "S10:1",
            speaker: "assistant",
            text: "The later source turn.",
            has_answer: true,
            answer: "TURN_GOLD_MUST_NOT_ESCAPE",
          },
        ],
        session_2_date_time: "2023/05/20 (Sat) 02:21",
        session_2: [
          {
            dia_id: "S2:1",
            speaker: "user",
            text: "  Preserve source whitespace.  ",
            evidence: "TURN_EVIDENCE_MUST_NOT_ESCAPE",
          },
        ],
        unsafe_conversation_field: "CONVERSATION_SECRET_MUST_NOT_ESCAPE",
      },
      metadata: {
        source_dataset: "longmemeval_s_cleaned",
        source_record_index: 64,
        original_question_id: "0862e8bf_abs",
        question_date: "2023/05/30 (Tue) 21:39",
        category_name: "single-session-user",
        answer_session_ids: ["S10"],
        unsafe: "METADATA_SECRET_MUST_NOT_ESCAPE",
      },
      qa: [
        {
          question_id: "0862e8bf_abs",
          question: "PRIVATE_QUESTION_TEXT",
          question_type: "single-session-user",
          category: 0,
          answer: "GOLD_ANSWER_MUST_NOT_ESCAPE",
          answer_fixed: "FIXED_GOLD_MUST_NOT_ESCAPE",
          evidence: ["S10:1"],
          evidence_qid: ["PRIVATE_EVIDENCE_QID"],
        },
      ],
      observation: ["TOP_LEVEL_SECRET_MUST_NOT_ESCAPE"],
    },
  ];
}

describe("LongMemEval-S trusted adapter", () => {
  it("creates deterministic opaque IDs and numerically ordered sessions", () => {
    const first = adaptLongMemEvalS(mixedFixture());
    const second = adaptLongMemEvalS(mixedFixture());

    expect(second).toEqual(first);
    expect(longMemEvalScopeId("0862e8bf_abs")).toBe(
      "lme-s-d39cc2d81053333d",
    );
    expect(
      longMemEvalSessionId(
        "lme-s-d39cc2d81053333d",
        "session_2",
      ),
    ).toBe("s-8a69de3487b818a2");
    expect(
      longMemEvalMemoryId("lme-s-d39cc2d81053333d", "S2:1"),
    ).toBe("m-372779e75b1ad47d64ec7eed");

    expect(
      first.memorySessions.map(
        (session) => session.metadata?.["sourceSessionId"],
      ),
    ).toEqual(["session_2", "session_10"]);
    expect(first.memorySessions.map((session) => session.sessionId)).toEqual([
      "s-8a69de3487b818a2",
      "s-0ec4a3d815b8de7e",
    ]);
    expect(
      first.memorySessions.flatMap((session) =>
        session.turns.map((turn) => turn.id),
      ),
    ).toEqual([
      "m-372779e75b1ad47d64ec7eed",
      "m-f2bcec9e7030be5eba6d0fbc",
    ]);
  });

  it("keeps only whitelisted conversation fields in memory", () => {
    const result = adaptLongMemEvalS(mixedFixture());
    const serializedMemory = JSON.stringify(result.memorySessions);

    expect(serializedMemory).toContain("Preserve source whitespace.");
    expect(serializedMemory).toContain("S2:1");
    expect(serializedMemory).not.toContain("0862e8bf_abs");
    expect(serializedMemory).not.toContain("PRIVATE_QUESTION_TEXT");
    expect(serializedMemory).not.toContain("GOLD_ANSWER_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain("FIXED_GOLD_MUST_NOT_ESCAPE");
    expect(serializedMemory).not.toContain(
      "TURN_GOLD_MUST_NOT_ESCAPE",
    );
    expect(serializedMemory).not.toContain(
      "TURN_EVIDENCE_MUST_NOT_ESCAPE",
    );
    expect(serializedMemory).not.toContain(
      "CONVERSATION_SECRET_MUST_NOT_ESCAPE",
    );
    expect(serializedMemory).not.toContain(
      "METADATA_SECRET_MUST_NOT_ESCAPE",
    );
    expect(serializedMemory).not.toContain(
      "TOP_LEVEL_SECRET_MUST_NOT_ESCAPE",
    );

    expect(result.memorySessions[0]?.turns[0]).toEqual({
      id: "m-372779e75b1ad47d64ec7eed",
      role: "user",
      content: "  Preserve source whitespace.  ",
      metadata: {
        sourceDiaId: "S2:1",
        sourceSpeaker: "user",
      },
    });
    expect(result.memorySessions[0]?.metadata).toEqual({
      sourceSessionId: "session_2",
      sessionTimeRaw: "2023/05/20 (Sat) 02:21",
      speakerA: "user",
      speakerB: "assistant",
    });
  });

  it("retains question identity only in the private envelope", () => {
    const result = adaptLongMemEvalS(mixedFixture());

    expect(result.privateQuestions).toEqual([
      {
        scopeId: "lme-s-d39cc2d81053333d",
        questionId: "0862e8bf_abs",
        question: "PRIVATE_QUESTION_TEXT",
        questionDate: "2023/05/30 (Tue) 21:39",
      },
    ]);
    expect(Object.keys(result.privateQuestions[0] ?? {}).sort()).toEqual([
      "question",
      "questionDate",
      "questionId",
      "scopeId",
    ]);
    expect(JSON.stringify(result.privateQuestions)).not.toContain(
      "GOLD_ANSWER_MUST_NOT_ESCAPE",
    );
  });

  it("normalizes timestamps without inventing a timezone", () => {
    expect(
      normalizeLongMemEvalTimestamp("2023/05/20 (Sat) 02:21"),
    ).toBe("2023-05-20T02:21:00");
    expect(() =>
      normalizeLongMemEvalTimestamp("2023/02/30 (Thu) 02:21"),
    ).toThrow(/valid calendar timestamp/u);
    expect(() =>
      normalizeLongMemEvalTimestamp("not-a-date"),
    ).toThrow(/must match/u);
  });

  it("fails closed on duplicate source coordinates", () => {
    const fixture = mixedFixture() as Array<Record<string, unknown>>;
    const record = fixture[0] as {
      conversation: Record<string, unknown>;
    };
    record.conversation["session_10"] = [
      {
        dia_id: "S2:1",
        speaker: "assistant",
        text: "Duplicate source coordinate.",
      },
    ];

    expect(() => adaptLongMemEvalS(fixture)).toThrow(
      /Duplicate dia_id "S2:1"/u,
    );
  });

  it("preserves source-addressable empty turns", () => {
    const fixture = mixedFixture() as Array<Record<string, unknown>>;
    const record = fixture[0] as {
      conversation: Record<string, unknown>;
    };
    record.conversation["session_2"] = [
      {
        dia_id: "S2:1",
        speaker: "user",
        text: "",
      },
    ];

    const result = adaptLongMemEvalS(fixture);
    expect(result.memorySessions[0]?.turns[0]?.content).toBe("");
    expect(result.memorySessions[0]?.turns[0]?.id).toBe(
      "m-372779e75b1ad47d64ec7eed",
    );
  });

  it("builds the LDBD answer prompt from every exact read source", () => {
    const retrieval = {
      status: "sufficient",
      evidenceSummary: "ORGANIZED_EVIDENCE_SUMMARY",
      citations: [
        { memoryId: "m-cited", supports: "Exact value" },
        { memoryId: "m-read-second", supports: "Second exact value" },
      ],
      evidence: [
        {
          memoryId: "m-cited",
          role: "user",
          timestamp: "2023-05-20T02:21:00",
          content: "CITED_SOURCE_VALUE",
        },
        {
          memoryId: "m-read-second",
          role: "assistant",
          content: "SECOND_READ_SOURCE_VALUE",
        },
      ],
    } as unknown as PicorerResult;

    const prompt = buildLongMemEvalAnswerPrompt("What is the value?", retrieval);

    expect(prompt.adapterId).toBe("longmemeval-s");
    expect(prompt.promptVersion).toBe(
      "ldbd-longmemeval-answer-read-evidence-v6",
    );
    expect(prompt.userPrompt).toContain("CITED_SOURCE_VALUE");
    expect(prompt.userPrompt).toContain("memoryId=m-cited");
    expect(prompt.userPrompt).toContain("SECOND_READ_SOURCE_VALUE");
    expect(prompt.userPrompt).not.toContain("ORGANIZED_EVIDENCE_SUMMARY");
    expect(prompt.userPrompt).not.toContain("retrieval_summary");
    expect(prompt.userPrompt).not.toContain("retrieval_package");
    expect(prompt.userPrompt).toContain("<memories>");
    expect(prompt.userPrompt).toContain("Question: What is the value?");
  });

  it("pins the byte-exact LDBD answer prompt contract", () => {
    expect(LONGMEMEVAL_ANSWER_PROMPT_VERSION).toBe(
      "ldbd-longmemeval-answer-read-evidence-v6",
    );
    expect(
      sha256(LONGMEMEVAL_ANSWER_PROMPT_TEMPLATE),
    ).toBe("ecfb93382f47ef1fc23d284182a0e49fca7e9a8cb4046ce2f51daadb110e29a5");
  });

  it("fails closed when the source is not the one-question-per-scope S split", () => {
    const fixture = mixedFixture() as Array<Record<string, unknown>>;
    const record = fixture[0] as { qa: unknown[] };
    record.qa.push({
      question_id: "second",
      question: "Second question",
    });

    expect(() => adaptLongMemEvalS(fixture)).toThrow(
      /exactly one LongMemEval-S question/u,
    );
  });
});
