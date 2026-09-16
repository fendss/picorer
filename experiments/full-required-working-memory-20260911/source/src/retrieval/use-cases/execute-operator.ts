import type {
  SearchOperatorExecutionContext,
  SearchOperatorInput,
  SearchOperatorOutput,
} from "../model/operator.js";
import type { SearchOperatorCatalog } from "../ports/operator-catalog.js";
import { mergeHitProvenance } from "../model/hit-provenance.js";
import { retrievalHitIdentity, assertPassageMatchesRecord } from "../model/passage.js";
import type { RetrievalHit } from "../model/search.js";

export interface ExecutedSearchOperator extends SearchOperatorOutput {
  operator: string;
  operatorVersion: string;
}

export async function executeSearchOperator(
  registry: SearchOperatorCatalog,
  operatorId: string,
  context: SearchOperatorExecutionContext,
  input: SearchOperatorInput,
): Promise<ExecutedSearchOperator> {
  context.signal?.throwIfAborted();
  const operator = registry.get(operatorId);
  const output = await operator.execute(context, input);
  context.signal?.throwIfAborted();
  const unique = new Map<string, RetrievalHit>();
  for (const hit of output.hits) {
    if (hit.record.scopeId !== context.scopeId) {
      throw new Error(
        `Search operator ${operator.id} returned memory outside scope ${context.scopeId}`,
      );
    }
    if (hit.passage !== undefined) assertPassageMatchesRecord(hit.passage, hit.record);
    const identity = retrievalHitIdentity(hit);
    const previous = unique.get(identity);
    unique.set(identity, previous === undefined ? hit : mergeHitProvenance(previous, hit));
  }
  return {
    ...output,
    hits: [...unique.values()].map((hit, index) => ({ ...hit, rank: index + 1 })),
    operator: operator.id,
    operatorVersion: operator.version,
  };
}
