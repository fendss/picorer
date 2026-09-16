import { resolve } from "node:path";
import type { PicorerSkill } from "../../evidence-agent/index.js";
import type { LoadPiModelRuntimeOptions } from "../../platform/pi/load-model-runtime.js";
import { requireEnvironmentVariable } from "../../platform/security/protected-environment.js";
import { parseRetrievalProfile } from "../../retrieval/retrieval-profile.js";
import type { RetrievalProfile } from "../../retrieval/index.js";

export interface ParsedCommand {
  command: string;
  flags: Map<string, string[]>;
}

export const MODEL_RUNTIME_FLAG_NAMES = [
  "agent-dir",
  "provider",
  "model",
  "model-adapter",
  "context-window",
  "max-tokens",
  "thinking-level",
  "api-key-env",
  "base-url-env",
  "transport",
] as const;

export function parseCommand(argv: string[]): ParsedCommand {
  const [command, ...tokens] = argv;
  if (!command) return { command: "help", flags: new Map() };
  const flags = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${String(token)}`);
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    const bucket = flags.get(name) ?? [];
    bucket.push(value);
    flags.set(name, bucket);
    index += 1;
  }
  return { command, flags };
}

export function requiredFlag(parsed: ParsedCommand, name: string): string {
  const values = parsed.flags.get(name);
  if (!values || values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`Expected exactly one --${name}`);
  }
  return values[0];
}

export function optionalFlag(
  parsed: ParsedCommand,
  name: string,
): string | undefined {
  const values = parsed.flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`Expected at most one --${name}`);
  }
  return values[0];
}

export function positiveIntegerFlag(
  parsed: ParsedCommand,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = optionalFlag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function positiveNumberFlag(
  parsed: ParsedCommand,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = optionalFlag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`--${name} must be greater than 0 and at most ${maximum}`);
  }
  return value;
}

export function modelOptionsFor(
  parsed: ParsedCommand,
): LoadPiModelRuntimeOptions {
  const agentDir = optionalFlag(parsed, "agent-dir");
  const providerId = optionalFlag(parsed, "provider");
  const modelId = optionalFlag(parsed, "model");
  const thinkingLevel = optionalFlag(parsed, "thinking-level");
  const apiKeyEnv = optionalFlag(parsed, "api-key-env");
  const baseUrlEnv = optionalFlag(parsed, "base-url-env");
  const transport = optionalFlag(parsed, "transport") ?? "sse";
  const modelAdapterId = optionalFlag(parsed, "model-adapter");
  const contextWindow = optionalFlag(parsed, "context-window");
  const maxTokens = optionalFlag(parsed, "max-tokens");
  const acceptedThinkingLevels = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  if (
    thinkingLevel !== undefined &&
    !acceptedThinkingLevels.has(thinkingLevel)
  ) {
    throw new Error(`Unknown thinking level: ${thinkingLevel}`);
  }
  if (transport !== "sse" && transport !== "non-stream") {
    throw new Error(`Unknown model transport: ${transport}`);
  }
  const parseOptionalPositiveInteger = (
    raw: string | undefined,
    name: string,
  ): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return value;
  };
  const parsedContextWindow = parseOptionalPositiveInteger(
    contextWindow,
    "context-window",
  );
  const parsedMaxTokens = parseOptionalPositiveInteger(
    maxTokens,
    "max-tokens",
  );
  const baseUrl = baseUrlEnv === undefined
    ? undefined
    : requireEnvironmentVariable(process.env, baseUrlEnv);
  if (apiKeyEnv !== undefined) {
    requireEnvironmentVariable(process.env, apiKeyEnv);
  }
  return {
    ...(agentDir === undefined ? {} : { agentDir: resolve(agentDir) }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(thinkingLevel === undefined
      ? {}
      : {
          thinkingLevel:
            thinkingLevel as NonNullable<
              LoadPiModelRuntimeOptions["thinkingLevel"]
            >,
        }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(modelAdapterId === undefined ? {} : { modelAdapterId }),
    ...(parsedContextWindow === undefined
      ? {}
      : { contextWindow: parsedContextWindow }),
    ...(parsedMaxTokens === undefined ? {} : { maxTokens: parsedMaxTokens }),
    transport,
  };
}

export function skillFor(parsed: ParsedCommand): PicorerSkill {
  const skill = optionalFlag(parsed, "skill") ?? "picorer-v0";
  if (
    skill !== "none" &&
    skill !== "picorer-minimal" &&
    skill !== "picorer-v0"
  ) {
    throw new Error(`Unknown Picorer skill: ${skill}`);
  }
  return skill;
}

export function assertOnlyFlags(
  parsed: ParsedCommand,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  for (const name of parsed.flags.keys()) {
    if (!accepted.has(name)) throw new Error(`Unknown flag: --${name}`);
  }
}

export function retrievalProfileFor(
  parsed: ParsedCommand,
): RetrievalProfile {
  return parseRetrievalProfile(optionalFlag(parsed, "retrieval-profile"));
}
