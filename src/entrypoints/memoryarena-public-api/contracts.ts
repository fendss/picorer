import {
  MemoryArenaPublicError,
  type MemoryArenaAddInput,
  type MemoryArenaInitializeInput,
  type MemoryArenaWrapInput,
} from "../../benchmark/memoryarena-public/index.js";

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function contractError(message: string): MemoryArenaPublicError {
  return new MemoryArenaPublicError({
    code: "contract_error",
    message,
    httpStatus: 422,
  });
}

function exactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const unsupported = Object.keys(record).filter((key) => !accepted.has(key));
  if (unsupported.length > 0) {
    throw contractError(
      `${label} has unsupported fields: ${unsupported.sort().join(", ")}`,
    );
  }
}

function stringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw contractError(`${label}.${field} must be a string`);
  }
  return value;
}

function addMessagesField(
  value: unknown,
): MemoryArenaAddInput["messages"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw contractError("Add request.messages must be a non-empty list");
  }
  return value.map((item, index) => {
    const label = `Add request.messages[${String(index)}]`;
    const message = objectValue(item, label);
    exactFields(message, ["role", "content", "timestamp"], label);
    const role = stringField(message, "role", label);
    if (!["user", "assistant", "system", "other"].includes(role)) {
      throw contractError(`${label}.role is unsupported`);
    }
    const timestamp = message.timestamp === undefined
      ? undefined
      : stringField(message, "timestamp", label);
    return {
      role: role as "user" | "assistant" | "system" | "other",
      content: stringField(message, "content", label),
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  });
}

function positiveIntegerField(
  record: Record<string, unknown>,
  field: string,
  label: string,
  maximum: number,
): number {
  const value = record[field];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw contractError(
      `${label}.${field} must be an integer between 1 and ${maximum}`,
    );
  }
  return value as number;
}

export function parseMemoryArenaInitializeRequest(
  value: unknown,
): MemoryArenaInitializeInput {
  const record = objectValue(value, "Initialize request");
  exactFields(record, ["user_id", "memory_system_name"], "Initialize request");
  return {
    userId: stringField(record, "user_id", "Initialize request"),
    memorySystemName: stringField(
      record,
      "memory_system_name",
      "Initialize request",
    ),
  };
}

export function parseMemoryArenaAddRequest(value: unknown): MemoryArenaAddInput {
  const record = objectValue(value, "Add request");
  exactFields(
    record,
    ["user_id", "memory_system_name", "chunk", "messages"],
    "Add request",
  );
  const messages = addMessagesField(record.messages);
  return {
    userId: stringField(record, "user_id", "Add request"),
    memorySystemName: stringField(record, "memory_system_name", "Add request"),
    chunk: stringField(record, "chunk", "Add request"),
    ...(messages === undefined ? {} : { messages }),
  };
}

export function parseMemoryArenaWrapRequest(value: unknown): MemoryArenaWrapInput {
  const record = objectValue(value, "Wrap request");
  exactFields(
    record,
    [
      "user_id",
      "memory_system_name",
      "question",
      "answer_handoff",
      "operator_experiment",
    ],
    "Wrap request",
  );
  const answerHandoff = record.answer_handoff;
  if (answerHandoff !== undefined && answerHandoff !== "evidence-aware-v1") {
    throw contractError(
      "Wrap request.answer_handoff must be evidence-aware-v1",
    );
  }
  const rawExperiment = record.operator_experiment;
  let operatorExperiment: MemoryArenaWrapInput["operatorExperiment"];
  if (rawExperiment !== undefined) {
    const experiment = objectValue(
      rawExperiment,
      "Wrap request.operator_experiment",
    );
    exactFields(
      experiment,
      ["mode", "question_id", "max_search_calls", "evolution_snapshot"],
      "Wrap request.operator_experiment",
    );
    const mode = stringField(
      experiment,
      "mode",
      "Wrap request.operator_experiment",
    );
    if (mode !== "static" && mode !== "ephemeral" && mode !== "cumulative") {
      throw contractError(
        "Wrap request.operator_experiment.mode must be static, ephemeral, or cumulative",
      );
    }
    if (mode !== "cumulative" && experiment.evolution_snapshot !== undefined) {
      throw contractError(
        "Wrap request.operator_experiment.evolution_snapshot requires cumulative mode",
      );
    }
    if (
      experiment.evolution_snapshot !== undefined &&
      (typeof experiment.evolution_snapshot !== "object" ||
        experiment.evolution_snapshot === null ||
        Array.isArray(experiment.evolution_snapshot))
    ) {
      throw contractError(
        "Wrap request.operator_experiment.evolution_snapshot must be an object",
      );
    }
    operatorExperiment = {
      mode,
      questionId: stringField(
        experiment,
        "question_id",
        "Wrap request.operator_experiment",
      ),
      maxSearchCalls: positiveIntegerField(
        experiment,
        "max_search_calls",
        "Wrap request.operator_experiment",
        16,
      ),
      ...(experiment.evolution_snapshot === undefined
        ? {}
        : {
            evolutionSnapshot: experiment.evolution_snapshot as NonNullable<
              NonNullable<MemoryArenaWrapInput["operatorExperiment"]>[
                "evolutionSnapshot"
              ]
            >,
          }),
    };
  }
  return {
    userId: stringField(record, "user_id", "Wrap request"),
    memorySystemName: stringField(record, "memory_system_name", "Wrap request"),
    question: stringField(record, "question", "Wrap request"),
    ...(answerHandoff === undefined ? {} : { answerHandoff }),
    ...(operatorExperiment === undefined ? {} : { operatorExperiment }),
  };
}
