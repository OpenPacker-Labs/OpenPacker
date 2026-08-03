import {
  createEmbeddedResolver,
  type EmbeddedBindings,
  type EmbeddedSolveInput,
  type EmbeddedSolveOutput,
  type OracleResult,
} from '@openpacker/embedded';

export interface EmbeddedExampleResult {
  output: EmbeddedSolveOutput;
  oracle: OracleResult;
}

/** Run the pure embedded solve, independent proof check, and bounded oracle. */
export function runEmbeddedResolver(
  bindings: EmbeddedBindings,
  input: EmbeddedSolveInput,
): EmbeddedExampleResult {
  const resolver = createEmbeddedResolver(bindings);
  resolver.validateUniverse(input.universe);
  const output = resolver.solve(input);
  const check = resolver.check(input, output);
  if (!check.valid)
    throw new Error(
      `Embedded proof check failed: ${check.diagnostics.join('; ')}`,
    );
  return { output, oracle: resolver.bruteForceOracle(input) };
}
