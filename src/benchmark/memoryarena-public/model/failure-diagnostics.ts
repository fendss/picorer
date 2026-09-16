import type { MemoryArenaOperationFailedRetrieval } from "./memory-backend.js";

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeCount(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = finiteNumber(record, key);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

const PROVIDER_FAILURE_KINDS = new Set([
  "content_filter",
  "http_error",
  "invalid_finish_reason",
  "invalid_json",
  "invalid_response",
  "model_substitution",
  "request_timeout",
  "transport_error",
  "unknown",
]);

function safeProviderFailureKind(
  value: unknown,
): MemoryArenaOperationFailedRetrieval["providerFailureKind"] {
  return typeof value === "string" && PROVIDER_FAILURE_KINDS.has(value)
    ? value as MemoryArenaOperationFailedRetrieval["providerFailureKind"]
    : undefined;
}

function safeProviderResponseModel(value: unknown): string | undefined {
  return typeof value === "string" &&
      /^[a-zA-Z0-9._:/-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

function modelUsage(
  value: unknown,
): MemoryArenaOperationFailedRetrieval["usage"] | undefined {
  const usage = recordValue(value);
  const cost = recordValue(usage?.cost);
  if (usage === undefined || cost === undefined) return undefined;
  const input = finiteNumber(usage, "input");
  const output = finiteNumber(usage, "output");
  const cacheRead = finiteNumber(usage, "cacheRead");
  const cacheWrite = finiteNumber(usage, "cacheWrite");
  const totalTokens = finiteNumber(usage, "totalTokens");
  const costInput = finiteNumber(cost, "input");
  const costOutput = finiteNumber(cost, "output");
  const costCacheRead = finiteNumber(cost, "cacheRead");
  const costCacheWrite = finiteNumber(cost, "cacheWrite");
  const costTotal = finiteNumber(cost, "total");
  if (
    input === undefined || output === undefined || cacheRead === undefined ||
    cacheWrite === undefined || totalTokens === undefined ||
    costInput === undefined || costOutput === undefined ||
    costCacheRead === undefined || costCacheWrite === undefined ||
    costTotal === undefined
  ) return undefined;
  const cacheWrite1h = finiteNumber(usage, "cacheWrite1h");
  const reasoning = finiteNumber(usage, "reasoning");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

/**
 * Extracts only bounded, content-free execution metadata from a PicorerRunError
 * and its cause chain. Source text, prompts, tool arguments, and model output
 * are deliberately excluded from the public/audit diagnostic contract.
 */
export function memoryArenaPicorerFailureDiagnostics(
  error: unknown,
): MemoryArenaOperationFailedRetrieval | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = recordValue(current);
    if (current instanceof Error && current.name === "PicorerRunError") {
      const diagnostics = recordValue(candidate?.diagnostics);
      const usage = modelUsage(diagnostics?.usage);
      const runId = diagnostics?.runId;
      const turns = diagnostics === undefined
        ? undefined
        : safeCount(diagnostics, "turns");
      const toolCalls = diagnostics === undefined
        ? undefined
        : safeCount(diagnostics, "toolCalls");
      if (
        diagnostics !== undefined && typeof runId === "string" &&
        turns !== undefined && toolCalls !== undefined && usage !== undefined
      ) {
        const providerFailureKind = safeProviderFailureKind(
          diagnostics.providerFailureKind,
        );
        const providerResponseModel = safeProviderResponseModel(
          diagnostics.providerResponseModel,
        );
        const trace = Array.isArray(diagnostics.trace) ? diagnostics.trace : [];
        const tools = new Map<string, number>();
        let errorEntries = 0;
        for (const entry of trace) {
          const traceEntry = recordValue(entry);
          if (traceEntry?.isError === true) errorEntries += 1;
          const rawTool = traceEntry?.toolName;
          const tool = typeof rawTool === "string" && rawTool.length > 0
            ? rawTool.slice(0, 128)
            : "unknown";
          tools.set(tool, (tools.get(tool) ?? 0) + 1);
        }
        return {
          runId,
          turns,
          toolCalls,
          ...(providerFailureKind === undefined ? {} : { providerFailureKind }),
          ...(providerResponseModel === undefined ? {} : { providerResponseModel }),
          candidateCount: Array.isArray(diagnostics.candidates)
            ? diagnostics.candidates.length
            : 0,
          evidenceCount: Array.isArray(diagnostics.evidence)
            ? diagnostics.evidence.length
            : 0,
          trace: {
            entries: trace.length,
            errorEntries,
            byTool: Object.fromEntries(
              [...tools.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
              ),
            ),
          },
          usage,
        };
      }
    }
    current = candidate?.cause;
  }
  return undefined;
}
