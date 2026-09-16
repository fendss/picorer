import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertOnlyFlags,
  requiredFlag,
  type ParsedCommand,
} from "../parse-command.js";

export async function prepareLongMemEvalEvaluation(
  parsed: ParsedCommand,
): Promise<void> {
  assertOnlyFlags(parsed, ["source", "predictions", "output"]);
  const sourcePath = resolve(requiredFlag(parsed, "source"));
  const predictionsPath = resolve(requiredFlag(parsed, "predictions"));
  const outputPath = resolve(requiredFlag(parsed, "output"));
  const [sourceSerialized, predictionsSerialized] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(predictionsPath, "utf8"),
  ]);
  const source = JSON.parse(sourceSerialized) as unknown;
  if (!Array.isArray(source)) {
    throw new Error("LongMemEval evaluator source must be an array");
  }
  const sourceByQuestionId = new Map<string, Record<string, unknown>>();
  for (const [index, rawRecord] of source.entries()) {
    if (
      typeof rawRecord !== "object" ||
      rawRecord === null ||
      Array.isArray(rawRecord)
    ) {
      throw new Error(`LongMemEval source record ${index} must be an object`);
    }
    const qa = (rawRecord as Record<string, unknown>).qa;
    if (!Array.isArray(qa) || qa.length !== 1) {
      throw new Error(`LongMemEval source record ${index} must have one QA`);
    }
    const question = qa[0];
    if (
      typeof question !== "object" ||
      question === null ||
      Array.isArray(question)
    ) {
      throw new Error(`LongMemEval source QA ${index} must be an object`);
    }
    const item = question as Record<string, unknown>;
    if (typeof item.question_id !== "string") {
      throw new Error(`LongMemEval source QA ${index} has no question_id`);
    }
    sourceByQuestionId.set(item.question_id, item);
  }

  const evaluatorRecords = predictionsSerialized
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const prediction = JSON.parse(line) as Record<string, unknown>;
      const questionId = prediction.question_id;
      if (
        typeof questionId !== "string" ||
        typeof prediction.response !== "string"
      ) {
        throw new Error(`Prediction line ${index + 1} is invalid`);
      }
      const sourceQuestion = sourceByQuestionId.get(questionId);
      if (!sourceQuestion) {
        throw new Error(`Prediction has unknown question_id: ${questionId}`);
      }
      const answer = sourceQuestion.answer_fixed ?? sourceQuestion.answer;
      if (
        typeof sourceQuestion.question !== "string" ||
        typeof sourceQuestion.question_type !== "string" ||
        typeof answer !== "string"
      ) {
        throw new Error(`Evaluator source fields are invalid: ${questionId}`);
      }
      return {
        question_id: questionId,
        abstention: questionId.endsWith("_abs"),
        question_type: sourceQuestion.question_type,
        question: sourceQuestion.question,
        answer,
        response: prediction.response,
        retrieval_status: prediction.retrieval_status,
        citations: prediction.citations,
      };
    });

  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(evaluatorRecords, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, outputPath);
  process.stdout.write(
    `${JSON.stringify({
      command: "prepare-longmemeval-eval",
      recordCount: evaluatorRecords.length,
      outputPath,
    }, null, 2)}\n`,
  );
}
