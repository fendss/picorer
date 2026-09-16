import { createBashRoTool } from "./bash-tool.js";
import type { CreatePicorerToolsOptions, PicorerTools } from "./contracts.js";
import { createFinishTool } from "./finish-tool.js";
import { createDefineOperatorTool } from "./define-operator-tool.js";
import { createReadTool } from "./read-tool.js";
import { createSearchTools } from "./search-tool.js";
import { createMemoryObservation } from "../memory-observation.js";

export function createPicorerTools(
  options: CreatePicorerToolsOptions,
): PicorerTools {
  const compact = options.interfaceMode === "compact";
  if (options.scopeId !== options.ledger.scopeId) {
    throw new Error(
      `Tool scope ${options.scopeId} does not match ledger scope ${options.ledger.scopeId}`,
    );
  }
  const observation = options.observation ?? createMemoryObservation({
    ledger: options.ledger,
    ...(compact ? { compact: true } : {}),
    ...(options.question === undefined ? {} : { question: options.question }),
    ...(options.questionDate === undefined
      ? {}
      : { questionDate: options.questionDate }),
    ...(options.maxSearchCalls === undefined
      ? {}
      : { maxSearchCalls: options.maxSearchCalls }),
  });
  const sharedOptions = { ...options, observation };
  const { search, searchMore } = createSearchTools(sharedOptions);
  const defineOperator = options.operatorDefinitions === undefined ||
    options.operatorDefinitions.remainingDefinitions() === 0
    ? undefined
    : createDefineOperatorTool({
        ...sharedOptions,
        operatorDefinitions: options.operatorDefinitions,
      });
  const read = createReadTool(sharedOptions);
  const bashRo =
    compact || options.bashRo === undefined
      ? undefined
      : createBashRoTool({
          ...sharedOptions,
          bashRo: options.bashRo,
        });
  const finish = createFinishTool(sharedOptions);
  const all = [
    search,
    searchMore,
    ...(defineOperator === undefined ? [] : [defineOperator]),
    read,
    ...(bashRo === undefined ? [] : [bashRo]),
    finish,
  ];
  return {
    search,
    searchMore,
    ...(defineOperator === undefined ? {} : { defineOperator }),
    read,
    ...(bashRo === undefined ? {} : { bashRo }),
    finish,
    all,
  };
}
