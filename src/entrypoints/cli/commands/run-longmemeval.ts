import { runBenchmarkAnswer } from "../../../benchmark/index.js";
import { dataPaths } from "../../../benchmark/longmemeval/data-paths.js";
import { buildLongMemEvalAnswerPrompt } from "../../../benchmark/longmemeval/dataset-adapter.js";
import type { LongMemEvalPrivateQuestion } from "../../../benchmark/longmemeval/dataset-adapter.js";
import { readScopeRecords } from "../private-records.js";
import { createReadOnlyScopeNavigation } from "../../../composition/create-read-only-navigation.js";
import { runPicorer } from "../../../evidence-agent/index.js";
import { createRetrievalContext } from "../../../composition/create-retrieval-context.js";
import { loadPiModelRuntime } from "../../../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../../../platform/sqlite/picorer-store.js";
import {
  assertOnlyFlags,
  MODEL_RUNTIME_FLAG_NAMES,
  modelOptionsFor,
  requiredFlag,
  retrievalProfileFor,
  skillFor,
  type ParsedCommand,
} from "../parse-command.js";

export async function runLongMemEval(parsed: ParsedCommand): Promise<void> {
  assertOnlyFlags(parsed, [
    "data-dir",
    "question-id",
    "retrieval-profile",
    ...MODEL_RUNTIME_FLAG_NAMES,
    "skill",
  ]);
  const paths = dataPaths(requiredFlag(parsed, "data-dir"));
  const questionId = requiredFlag(parsed, "question-id");
  const questions = await readScopeRecords<LongMemEvalPrivateQuestion>(
    paths.privateQuestions,
  );
  const question = questions.find((item) => item.questionId === questionId);
  if (!question) {
    throw new Error("Question is not present in the private runner map");
  }
  const rawStore = await MemoryStore.create(paths.database);
  try {
    const modelRuntime = await loadPiModelRuntime(modelOptionsFor(parsed));
    const context = createRetrievalContext(
      rawStore,
      retrievalProfileFor(parsed),
    );
    const retrieval = await runPicorer({
      store: context.store,
      operatorRegistry: context.operatorRegistry,
      modelRuntime,
      scopeId: question.scopeId,
      question: question.question,
      ...(question.questionDate === undefined
        ? {}
        : { questionDate: question.questionDate }),
      skill: skillFor(parsed),
      readOnlyNavigation: createReadOnlyScopeNavigation(
        paths.sanitized,
        question.scopeId,
      ),
    });
    const answer = await runBenchmarkAnswer({
      modelRuntime,
      prompt: buildLongMemEvalAnswerPrompt(question.question, retrieval),
    });
    process.stdout.write(
      `${JSON.stringify({ questionId, retrieval, answer }, null, 2)}\n`,
    );
  } finally {
    rawStore.close();
  }
}
