import { Agent, type Dispatcher } from "undici";

// A scoped pool, not a process-global dispatcher override. Request deadlines
// remain owned by the caller's AbortSignal, including response body consumption.
// Inference POSTs use independent connections; stale idle sockets are never reused.
const pool = new Agent({ pipelining: 0 });

export function fetchWithHttpTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(input, init);
  }
  const dispatcher: Pick<Dispatcher, "dispatch"> = {
    dispatch(options, handler) {
      // Native fetch has its own HTTP timeouts, independent of AbortSignal.
      return pool.dispatch({ ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }, handler);
    },
  };
  const request: RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> } = { ...init, dispatcher };
  return fetch(input, request);
}

export function transportErrorMessage(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as Error & { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
    current = current.cause;
  }
  return parts.join(": ").slice(0, 2_000);
}
