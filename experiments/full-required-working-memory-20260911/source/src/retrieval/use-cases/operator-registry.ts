import type {
  DefinedSearchOperator,
  SearchOperatorCatalogEntry,
  SearchOperatorCatalogIdentity,
  SearchOperatorDefinition,
  SearchOperatorDefinitionSnapshot,
} from "../model/operator.js";
import type {
  RuntimeSearchOperatorCatalog,
  SearchOperatorCatalog,
} from "../ports/operator-catalog.js";
import type { SearchOperator } from "../ports/search-operator.js";
import { sha256 } from "../../util.js";
import { buildDeclarativeSearchOperator } from "./compose-operator.js";

const OPERATOR_ID = /^[a-z][a-z0-9._-]{0,63}$/u;

function normalizedText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function catalogEntry(operator: SearchOperator): SearchOperatorCatalogEntry {
  return {
    id: operator.id,
    version: operator.version,
    guide: {
      summary: operator.guide.summary,
      useWhen: [...operator.guide.useWhen],
      ...(operator.guide.avoidWhen === undefined
        ? {}
        : { avoidWhen: [...operator.guide.avoidWhen] }),
      cost: operator.guide.cost,
    },
  };
}

export class SearchOperatorRegistry {
  readonly defaultOperatorId: string;

  private readonly operators = new Map<string, SearchOperator>();
  private frozen = false;

  constructor(defaultOperatorId = "hybrid") {
    this.defaultOperatorId = normalizedText(
      defaultOperatorId,
      "Default operator ID",
    );
  }

  register(operator: SearchOperator): this {
    if (this.frozen) {
      throw new Error("Search operator registry is frozen");
    }
    const id = normalizedText(operator.id, "Search operator ID");
    if (!OPERATOR_ID.test(id)) {
      throw new Error(
        `Invalid search operator ID ${JSON.stringify(id)}; expected ${String(OPERATOR_ID)}`,
      );
    }
    normalizedText(operator.version, `Search operator ${id} version`);
    normalizedText(operator.guide.summary, `Search operator ${id} summary`);
    if (operator.guide.useWhen.length === 0) {
      throw new Error(`Search operator ${id} must declare at least one useWhen rule`);
    }
    if (this.operators.has(id)) {
      throw new Error(`Search operator ${id} is already registered`);
    }
    this.operators.set(id, operator);
    return this;
  }

  freeze(): this {
    if (!this.operators.has(this.defaultOperatorId)) {
      throw new Error(
        `Default search operator ${this.defaultOperatorId} is not registered`,
      );
    }
    this.frozen = true;
    return this;
  }

  get(operatorId: string): SearchOperator {
    this.assertFrozen();
    const operator = this.operators.get(operatorId);
    if (operator === undefined) {
      const available = [...this.operators.keys()].sort().join(", ");
      throw new Error(
        `Unknown search operator ${JSON.stringify(operatorId)}. Available: ${available || "none"}`,
      );
    }
    return operator;
  }

  list(): SearchOperatorCatalogEntry[] {
    this.assertFrozen();
    return [...this.operators.values()].map(catalogEntry);
  }

  forkForRun(maxDefinitions = 2): RuntimeSearchOperatorCatalog {
    this.assertFrozen();
    return new RunSearchOperatorCatalog(this, maxDefinitions);
  }

  private assertFrozen(): void {
    if (!this.frozen) {
      throw new Error("Search operator registry must be frozen before use");
    }
  }
}

class RunSearchOperatorCatalog implements RuntimeSearchOperatorCatalog {
  readonly defaultOperatorId: string;

  private readonly definitions = new Map<string, {
    operator: SearchOperator;
    definition: SearchOperatorDefinition;
    definitionHash: string;
    revision: number;
  }>();
  private revision = 0;

  constructor(
    private readonly base: SearchOperatorRegistry,
    private readonly maxDefinitions: number,
  ) {
    if (
      !Number.isInteger(maxDefinitions) ||
      maxDefinitions < 0 ||
      maxDefinitions > 8
    ) {
      throw new Error(
        "Run operator definition budget must be an integer between 0 and 8",
      );
    }
    this.defaultOperatorId = base.defaultOperatorId;
  }

  get(operatorId: string): SearchOperator {
    const custom = this.definitions.get(operatorId);
    if (custom !== undefined) return custom.operator;
    return this.base.get(operatorId);
  }

  list(): SearchOperatorCatalogEntry[] {
    return [
      ...this.base.list(),
      ...[...this.definitions.values()].map(({ operator }) =>
        catalogEntry(operator)
      ),
    ];
  }

  define(source: SearchOperatorDefinition): DefinedSearchOperator {
    if (this.definitions.size >= this.maxDefinitions) {
      throw new Error(
        `Run operator definition budget exhausted (${this.maxDefinitions})`,
      );
    }
    const requestedId = source.id.trim();
    if (this.list().some((entry) => entry.id === requestedId)) {
      throw new Error(`Search operator ${requestedId} is already registered`);
    }
    const nextRevision = this.revision + 1;
    const built = buildDeclarativeSearchOperator(this, source, nextRevision);
    this.definitions.set(built.operator.id, {
      operator: built.operator,
      definition: built.definition,
      definitionHash: built.definitionHash,
      revision: nextRevision,
    });
    this.revision = nextRevision;
    return {
      id: built.operator.id,
      version: built.operator.version,
      definitionHash: built.definitionHash,
      catalog: this.identity(),
    };
  }

  identity(): SearchOperatorCatalogIdentity {
    return {
      revision: this.revision,
      hash: sha256(JSON.stringify({
        base: this.base.list(),
        definitions: [...this.definitions.entries()].map(([id, entry]) => ({
          id,
          version: entry.operator.version,
          definitionHash: entry.definitionHash,
        })),
      })),
    };
  }

  snapshots(): SearchOperatorDefinitionSnapshot[] {
    return [...this.definitions.values()].map((entry) => ({
      revision: entry.revision,
      definitionHash: entry.definitionHash,
      definition: structuredClone(entry.definition),
    }));
  }

  remainingDefinitions(): number {
    return this.maxDefinitions - this.definitions.size;
  }
}

export function renderSearchOperatorCatalog(
  entries: readonly SearchOperatorCatalogEntry[],
): string {
  if (entries.length === 0) return "No primitive retrievers are available.";
  return [
    "Available primitive retrievers and run-local plans (pass the id exactly as search.operator; version is informational):",
    ...entries.flatMap((entry) => [
      `- id=${entry.id} | version=${entry.version} | cost=${entry.guide.cost} | ${entry.guide.summary}`,
      `  use_when=${entry.guide.useWhen.join("; ")}`,
      ...(entry.guide.avoidWhen === undefined || entry.guide.avoidWhen.length === 0
        ? []
        : [`  avoid_when=${entry.guide.avoidWhen.join("; ")}`]),
    ]),
  ].join("\n");
}
