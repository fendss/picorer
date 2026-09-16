export interface LdbdAddMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface LdbdAddRequest {
  requestId: string;
  userId: string;
  sessionId: string;
  messages: LdbdAddMessage[];
}

export interface LdbdSearchRequest {
  query: string;
  userId: string;
  topK: number;
  options: string[];
}

export class LdbdContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LdbdContractError";
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LdbdContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !accepted.has(key));
  if (extra.length > 0) {
    throw new LdbdContractError(`${label} has unsupported fields: ${extra.join(", ")}`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LdbdContractError(`${label} must be a non-empty string`);
  }
  if (value.length > 512) throw new LdbdContractError(`${label} exceeds 512 characters`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LdbdContractError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new LdbdContractError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

export function parseAddRequest(value: unknown): LdbdAddRequest {
  const body = objectValue(value, "Add request");
  exactFields(body, ["request_id", "messages", "user_id", "session_id"], "Add request");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new LdbdContractError("messages must be a non-empty array");
  }
  if (body.messages.length > 100) {
    throw new LdbdContractError("messages must not contain more than 100 items");
  }
  const messages = body.messages.map((item, index): LdbdAddMessage => {
    const message = objectValue(item, `messages[${index}]`);
    exactFields(message, ["role", "content", "timestamp"], `messages[${index}]`);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new LdbdContractError(`messages[${index}].role must be user or assistant`);
    }
    if (
      message.timestamp !== undefined &&
      (typeof message.timestamp !== "number" || !Number.isSafeInteger(message.timestamp))
    ) {
      throw new LdbdContractError(`messages[${index}].timestamp must be a Unix-millisecond integer`);
    }
    return {
      role: message.role,
      content: text(message.content, `messages[${index}].content`, 500_000),
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    };
  });
  return {
    requestId: identifier(body.request_id, "request_id"),
    userId: identifier(body.user_id, "user_id"),
    sessionId: identifier(body.session_id, "session_id"),
    messages,
  };
}

export function parseSearchRequest(value: unknown): LdbdSearchRequest {
  const body = objectValue(value, "Search request");
  exactFields(body, ["query", "options", "user_id", "top_k"], "Search request");
  if (
    typeof body.top_k !== "number" ||
    !Number.isSafeInteger(body.top_k) ||
    body.top_k < 1 ||
    body.top_k > 1_000
  ) {
    throw new LdbdContractError("top_k must be an integer between 1 and 1000");
  }
  if (body.options !== undefined && !Array.isArray(body.options)) {
    throw new LdbdContractError("options must be an array when provided");
  }
  const options = (body.options ?? []).map((option, index) =>
    text(option, `options[${index}]`, 100_000),
  );
  if (options.length > 100) {
    throw new LdbdContractError("options must not contain more than 100 items");
  }
  return {
    query: text(body.query, "query", 100_000),
    userId: identifier(body.user_id, "user_id"),
    topK: body.top_k,
    options,
  };
}

export function renderRetrievalQuestion(request: LdbdSearchRequest): string {
  if (request.options.length === 0) return request.query;
  return [
    request.query,
    "",
    "Answer candidates supplied by the benchmark (use them only to guide retrieval):",
    ...request.options.map((option) => `- ${option}`),
  ].join("\n");
}
