import { builtInSearchOperators } from "../retrieval/adapters/operators/builtins.js";
import {
  SearchOperatorRegistry,
  type SearchOperator,
  type SearchOperatorStore,
} from "../retrieval/index.js";

/** Builds the allowlisted operator catalog once and freezes it for the run. */
export function createSearchOperatorRegistry(
  store: SearchOperatorStore,
  additionalOperators: readonly SearchOperator[] = [],
): SearchOperatorRegistry {
  const registry = new SearchOperatorRegistry("hybrid");
  for (const operator of [
    ...builtInSearchOperators(store),
    ...additionalOperators,
  ]) {
    registry.register(operator);
  }
  return registry.freeze();
}

/**
 * Builds a caller-facing catalog from an explicit built-in allowlist.
 * This keeps operator availability a composition decision without adding
 * caller policy to the registry or operator implementations.
 */
export function createSelectedSearchOperatorRegistry(
  store: SearchOperatorStore,
  builtInOperatorIds: readonly string[],
  additionalOperators: readonly SearchOperator[] = [],
): SearchOperatorRegistry {
  if (builtInOperatorIds.length === 0) {
    throw new Error("At least one built-in search operator must be selected");
  }
  const available = new Map(
    builtInSearchOperators(store).map((operator) => [operator.id, operator]),
  );
  const selected = builtInOperatorIds.map((id) => {
    const operator = available.get(id);
    if (operator === undefined) {
      throw new Error(`Unknown built-in search operator: ${id}`);
    }
    return operator;
  });
  const registry = new SearchOperatorRegistry(selected[0]!.id);
  for (const operator of [...selected, ...additionalOperators]) {
    registry.register(operator);
  }
  return registry.freeze();
}
