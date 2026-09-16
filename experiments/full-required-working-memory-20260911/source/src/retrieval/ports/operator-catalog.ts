import type {
  DefinedSearchOperator,
  SearchOperatorCatalogEntry,
  SearchOperatorCatalogIdentity,
  SearchOperatorDefinition,
  SearchOperatorDefinitionSnapshot,
} from "../model/operator.js";
import type { SearchOperator } from "./search-operator.js";

/** Read-only operator resolution needed by search execution. */
export interface SearchOperatorCatalog {
  readonly defaultOperatorId: string;
  get(operatorId: string): SearchOperator;
  list(): SearchOperatorCatalogEntry[];
}

/** Run-private definition capability; never implemented by the global catalog. */
export interface RuntimeSearchOperatorCatalog extends SearchOperatorCatalog {
  define(definition: SearchOperatorDefinition): DefinedSearchOperator;
  identity(): SearchOperatorCatalogIdentity;
  snapshots(): SearchOperatorDefinitionSnapshot[];
  remainingDefinitions(): number;
}
