import type { SearchOperatorStore } from "./memory-tool-store.js";
import type { SearchOperator } from "./search-operator.js";

/** Deploy-time factory contract implemented by a trusted local operator module. */
export type SearchOperatorPluginFactory = (
  store: SearchOperatorStore,
) =>
  | SearchOperator
  | readonly SearchOperator[]
  | Promise<SearchOperator | readonly SearchOperator[]>;

export interface SearchOperatorPluginModule {
  createSearchOperators: SearchOperatorPluginFactory;
}
