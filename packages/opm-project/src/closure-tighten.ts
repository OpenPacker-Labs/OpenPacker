import type { PackageInstance, Requirement } from '@openpacker/contracts';
import { baseOf } from './closure-edges.js';
import { nativeRange, satisfiesNative } from './requirement-info.js';

/**
 * Narrow an edge the solver read more widely than the ecosystem does.
 *
 * The solver is given a requirement as a comparison (`vers`), and a comparison
 * is a superset of npm's range where a prerelease is concerned: `^7.0.0-0` is
 * `>=7.0.0-0 <8.0.0-0` to npm and `>=7.0.0-0|<8.0.0` to the solver, which
 * admits `8.0.0-rc.6`, and `*` admits every prerelease. The selection is
 * therefore checked against the native range edge by edge, and an edge it
 * leaves unmet is given, in the universe of the next solve, the exact list of
 * the candidates the ecosystem accepts for it. Only that edge changes, so a
 * closure that did not need this is solved as it always was. ADR 0054.
 */

/** The key under which an edge is remembered as narrowed. */
const edgeKey = (nodeId: string, requirementId: string): string =>
  `${nodeId}\0${requirementId}`;

export function narrowUnmetEdges(input: {
  packages: readonly PackageInstance[];
  unmet: readonly { from: PackageInstance; requirement: Requirement }[];
  /** Edges narrowed already; extended with the ones narrowed now. */
  narrowed: Set<string>;
}): { packages: PackageInstance[]; changed: boolean } {
  const exact = new Map<string, string>();
  for (const { from, requirement } of input.unmet) {
    const key = edgeKey(from.nodeId, requirement.id);
    const range = nativeRange(requirement);
    if (input.narrowed.has(key) || range === undefined) continue;
    const accepted = input.packages.filter(
      (candidate) =>
        candidate.identity.canonicalPurl === baseOf(requirement) &&
        satisfiesNative(
          candidate.identity.purlType,
          candidate.nativeVersion,
          range,
        ),
    );
    // A version that cannot be written in a comparison is left to the error.
    if (
      accepted.length === 0 ||
      accepted.some((candidate) => /[|<>=!~*\s]/u.test(candidate.nativeVersion))
    )
      continue;
    input.narrowed.add(key);
    exact.set(
      key,
      `vers:${accepted[0]!.identity.purlType}/${accepted
        .map((candidate) => candidate.nativeVersion)
        .join('||')}`,
    );
  }
  if (exact.size === 0)
    return { packages: [...input.packages], changed: false };
  return {
    changed: true,
    packages: input.packages.map((instance) =>
      instance.requirements.some((requirement) =>
        exact.has(edgeKey(instance.nodeId, requirement.id)),
      )
        ? {
            ...instance,
            requirements: instance.requirements.map((requirement) => {
              const vers = exact.get(edgeKey(instance.nodeId, requirement.id));
              return vers === undefined ||
                requirement.expression.type !== 'package'
                ? requirement
                : {
                    ...requirement,
                    expression: { ...requirement.expression, vers },
                  };
            }),
          }
        : instance,
    ),
  };
}
