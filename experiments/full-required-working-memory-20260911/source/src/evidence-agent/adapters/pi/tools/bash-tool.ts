import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BashRoParameters } from "./schemas.js";
import type {
  BashRoToolDetails,
  CreatePicorerToolsOptions,
} from "./contracts.js";

export function createBashRoTool(
  options: CreatePicorerToolsOptions & {
    bashRo: NonNullable<CreatePicorerToolsOptions["bashRo"]>;
  },
): AgentTool<typeof BashRoParameters, BashRoToolDetails> {
  return {
    name: "bash_ro",
    label: "Explore raw memory",
    description:
      "Run grep/sed/awk/find or small Python scripts over this scope's sanitized raw-memory files. memory.jsonl fields include memoryId, timestamp, sessionId, turnIndex, role, and content; print memoryId for every relevant row. The container is read-only and has no network. Output is navigation only; call read for any source that should enter the final package.",
    parameters: BashRoParameters,
    async execute(_toolCallId, params, signal) {
      const command = params.command.trim();
      const result = await options.bashRo.runner.run(
        options.bashRo.scopePath,
        command,
        signal,
      );
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const memoryIds = options.bashRo.store.findMentionedMemoryIds(
        options.scopeId,
        combinedOutput,
      );
      const records = options.bashRo.store.getRecords(
        options.scopeId,
        memoryIds,
      );
      const candidates = options.ledger.recordBashDiscoveries(
        records,
        command,
      );
      const candidateReferences = candidates.map((candidate) => ({
        candidateRef: options.ledger.candidateRef(candidate.memoryId)!,
        memoryId: candidate.memoryId,
      }));
      const details: BashRoToolDetails = {
        kind: "bash_ro",
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
        memoryIds,
        candidateReferences,
        candidates,
      };
      const visibleStdout = candidateReferences.reduce(
        (text, item) => text.replaceAll(
          item.memoryId,
          `[candidate:${String(item.candidateRef)}]`,
        ),
        result.stdout,
      );
      const visibleStderr = candidateReferences.reduce(
        (text, item) => text.replaceAll(
          item.memoryId,
          `[candidate:${String(item.candidateRef)}]`,
        ),
        result.stderr,
      );
      const visible = [
        visibleStdout || "(no stdout)",
        visibleStderr ? `stderr:\n${visibleStderr}` : "",
        result.truncated ? "[output truncated]" : "",
        `discovered_candidate_refs=${JSON.stringify(candidateReferences.map((item) => item.candidateRef))}`,
        `exit_code=${String(result.exitCode)}`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text: visible }],
        details,
      };
    },
  };
}
