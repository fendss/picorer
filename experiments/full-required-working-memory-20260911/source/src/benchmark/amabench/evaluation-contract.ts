import type {
  AmaBenchCapability,
  AmaBenchDomain,
  AmaBenchPrivateLabel,
  AmaBenchPrivateQuery,
  AmaBenchTaskType,
} from "./dataset-adapter.js";

export interface AmaBenchQuestionPrediction {
  scopeId: string;
  episodeId: number;
  questionId: string;
  questionIndex: number;
  answer: string;
  reasoningTrace?: string;
}

/** DTO matching the fields consumed by the official v4 LLM-judge pipeline. */
export interface AmaBenchEvaluatorInput {
  episode_id: number;
  question_uuid: string;
  task_type: AmaBenchTaskType;
  domain: AmaBenchDomain;
  task_description: string;
  question: string;
  golden_answer: string;
  predicted_answer: string;
  qa_type: AmaBenchCapability;
}

/** Official leaderboard submission shape: one ordered answer list per episode. */
export interface AmaBenchEpisodeSubmission {
  episode_id: number;
  answer_list: string[];
  reasoning_trace?: string;
}

function assertSameIdentity(
  query: AmaBenchPrivateQuery,
  label: AmaBenchPrivateLabel,
  prediction: AmaBenchQuestionPrediction,
): void {
  const expected = [
    query.scopeId,
    query.episodeId,
    query.questionId,
    query.questionIndex,
  ] as const;
  const labelIdentity = [
    label.scopeId,
    label.episodeId,
    label.questionId,
    label.questionIndex,
  ] as const;
  const predictionIdentity = [
    prediction.scopeId,
    prediction.episodeId,
    prediction.questionId,
    prediction.questionIndex,
  ] as const;
  if (
    expected.some((value, index) => value !== labelIdentity[index]) ||
    expected.some((value, index) => value !== predictionIdentity[index])
  ) {
    throw new Error("AMA-Bench query, label, and prediction identities differ");
  }
}

/** Joins labels only at the evaluator boundary, after a prediction is frozen. */
export function buildAmaBenchEvaluatorInput(
  query: AmaBenchPrivateQuery,
  label: AmaBenchPrivateLabel,
  prediction: AmaBenchQuestionPrediction,
): AmaBenchEvaluatorInput {
  assertSameIdentity(query, label, prediction);
  if (prediction.answer.trim().length === 0) {
    throw new Error("AMA-Bench prediction answer must not be empty");
  }
  return {
    episode_id: query.episodeId,
    question_uuid: query.questionId,
    task_type: label.taskType,
    domain: label.domain,
    task_description: label.taskDescription,
    question: query.question,
    golden_answer: label.referenceAnswer,
    predicted_answer: prediction.answer,
    qa_type: label.capability,
  };
}

export function buildAmaBenchEpisodeSubmissions(
  predictions: readonly AmaBenchQuestionPrediction[],
): AmaBenchEpisodeSubmission[] {
  const byEpisode = new Map<number, AmaBenchQuestionPrediction[]>();
  for (const prediction of predictions) {
    if (prediction.answer.trim().length === 0) {
      throw new Error("AMA-Bench prediction answer must not be empty");
    }
    const bucket = byEpisode.get(prediction.episodeId) ?? [];
    bucket.push(prediction);
    byEpisode.set(prediction.episodeId, bucket);
  }

  return [...byEpisode.entries()]
    .sort(([left], [right]) => left - right)
    .map(([episodeId, episodePredictions]) => {
      const ordered = [...episodePredictions].sort(
        (left, right) => left.questionIndex - right.questionIndex,
      );
      const seenIndices = new Set<number>();
      const seenQuestionIds = new Set<string>();
      const scopeIds = new Set(ordered.map((prediction) => prediction.scopeId));
      if (scopeIds.size !== 1) {
        throw new Error(`AMA-Bench episode ${episodeId} has multiple scopes`);
      }
      ordered.forEach((prediction, index) => {
        if (prediction.questionIndex !== index) {
          throw new Error(
            `AMA-Bench episode ${episodeId} question indices must be contiguous from zero`,
          );
        }
        if (seenIndices.has(prediction.questionIndex)) {
          throw new Error(
            `Duplicate AMA-Bench question index in episode ${episodeId}`,
          );
        }
        if (seenQuestionIds.has(prediction.questionId)) {
          throw new Error(
            `Duplicate AMA-Bench question UUID in episode ${episodeId}`,
          );
        }
        seenIndices.add(prediction.questionIndex);
        seenQuestionIds.add(prediction.questionId);
      });

      const traceParts = ordered.flatMap((prediction) =>
        prediction.reasoningTrace === undefined ||
        prediction.reasoningTrace.trim().length === 0
          ? []
          : [
              `Question ${prediction.questionIndex + 1} (${prediction.questionId})\n${prediction.reasoningTrace}`,
            ],
      );
      return {
        episode_id: episodeId,
        answer_list: ordered.map((prediction) => prediction.answer),
        ...(traceParts.length === 0
          ? {}
          : { reasoning_trace: traceParts.join("\n\n") }),
      };
    });
}
