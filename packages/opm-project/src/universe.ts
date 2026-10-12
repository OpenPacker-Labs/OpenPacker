import {
  canonicalDigest,
  canonicalProjectionDigest,
} from '@openpacker/canonical';
import { DIGEST_PROJECTIONS, type JsonValue } from '@openpacker/contracts';
import { OpmError } from './types.js';
import type { ResolvedGraph } from './resolve.js';

/** A `ResolutionUniverse` over everything the walk found. */
export async function universeFrom(
  graph: ResolvedGraph,
): Promise<Record<string, unknown>> {
  const packages = graph.packages.map((instance) => ({
    ...instance,
    requirements: instance.requirements.map((requirement) => ({
      ...requirement,
      expression: completeExpression(requirement.expression),
    })),
    capabilities: instance.capabilities.map((capability) => ({
      attributes: {},
      ...capability,
    })),
    conflicts: instance.conflicts.map((conflict) => ({
      ...conflict,
      expression: completeExpression(conflict.expression),
    })),
    cardinalityConstraints: instance.cardinalityConstraints.map(
      (constraint) => ({
        ...constraint,
        selector: completeExpression(constraint.selector),
      }),
    ),
  }));
  const body = {
    universeVersion: '1',
    packages,
    overlays: [],
    sourceSnapshots: [],
    lifecycleRoot: await canonicalDigest([]),
    targetVocabularyVersion: '1',
  };
  const projection = DIGEST_PROJECTIONS.projections.find(
    ({ id }) => id === 'universe-v1',
  );
  if (!projection)
    throw new OpmError('INTERNAL_ERROR', 'Missing universe-v1 projection');
  const universeDigest = await canonicalProjectionDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(body)) as JsonValue,
    projection,
  );
  return {
    ...body,
    canonicalDigest: universeDigest,
  };
}

function completeExpression(input: JsonValue): JsonValue {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  if (input.type === 'package') return { qualifiers: {}, ...input };
  if (input.type === 'capability') return { attributes: {}, ...input };
  if (input.type === 'allOf' || input.type === 'anyOf')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expressions: (input.expressions as JsonValue[]).map(completeExpression),
    };
  if (input.type === 'not')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expression: completeExpression(input.expression as JsonValue),
    };
  if (input.type === 'conditional')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      // oxlint-disable-next-line unicorn/no-thenable -- PREX conditional AST field.
      then: completeExpression(input.then as JsonValue),
      ...(!(input.else === undefined) && {
        else: completeExpression(input.else),
      }),
    };
  return input;
}
