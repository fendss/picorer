import type {
  SearchOperatorExecutionContext,
  SearchOperatorGuide,
  SearchOperatorInput,
  SearchOperatorOutput,
} from "../model/operator.js";

/**
 * Stable search-operator SPI.
 *
 * Operators discover candidates only. Exact reads and evidence promotion stay
 * in the trusted evidence-agent kernel.
 */
export interface SearchOperator {
  readonly id: string;
  readonly version: string;
  readonly guide: SearchOperatorGuide;
  execute(
    context: SearchOperatorExecutionContext,
    input: SearchOperatorInput,
  ): Promise<SearchOperatorOutput>;
}
