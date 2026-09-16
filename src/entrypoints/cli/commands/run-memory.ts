import { join, resolve } from "node:path";
import { runQuestion } from "../../../composition/run-question.js";
import {
  assertOnlyFlags,
  MODEL_RUNTIME_FLAG_NAMES,
  modelOptionsFor,
  optionalFlag,
  requiredFlag,
  retrievalProfileFor,
  skillFor,
  type ParsedCommand,
} from "../parse-command.js";

export async function runGeneric(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "data-dir",
    "scope",
    "question",
    "question-date",
    "retrieval-profile",
    ...MODEL_RUNTIME_FLAG_NAMES,
    "skill",
  ]);
  const dataDir = resolve(requiredFlag(parsed, "data-dir"));
  const result = await runQuestion(
    {
      database: join(dataDir, "memory.sqlite"),
      sanitized: join(dataDir, "sanitized"),
    },
    retrievalProfileFor(parsed),
    requiredFlag(parsed, "scope"),
    requiredFlag(parsed, "question"),
    optionalFlag(parsed, "question-date"),
    modelOptionsFor(parsed),
    skillFor(parsed),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
