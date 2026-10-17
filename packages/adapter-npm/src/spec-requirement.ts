import type { Requirement } from '@openpacker/contracts';
import {
  ProviderError,
  semanticLoss,
  sourceRef,
} from '@openpacker/adapter-core';
import type { NpmDependencySpecKind } from './dependency-spec.js';

/**
 * A dependency whose specifier is not a version range: a dist-tag, git, a URL,
 * a file or a workspace.
 *
 * A dist-tag (`"foo": "latest"`) in a field an install walks is a requirement
 * on the registry's `foo` at whatever version its `dist-tags` name, which the
 * resolver reads (ADR 0054 §3, amended 2026-10-17): npm and pnpm resolve it so,
 * and the package it names is the one a range on the same key would name. A
 * tag npm would refuse to read (npm-package-arg@14.0.0 `lib/npa.js` 468-469:
 * one with characters `encodeURIComponent` changes) is refused here too.
 *
 * Git, URL and file specifiers are never read as the registry's package of that
 * name: that is a dependency-confusion door, so where the walk follows the field
 * they fail by name (ADR 0044 §1). In a field it does not walk (development,
 * optional peers) each is kept as what it says, with no version constraint.
 */
export function nonRangeRequirement(input: {
  dependerNodeId: string;
  name: string;
  spec: string;
  specKind: Exclude<NpmDependencySpecKind, 'range'>;
  kind: Requirement['kind'];
  optional: boolean;
  endpoint: string;
  path: string;
  dependencyField: string;
  owner: string;
  enforced: boolean;
  followed: boolean;
  /**
   * The registry package `name` is; asked only for a requirement that is
   * kept, since a key that is no package name is refused by name first.
   */
  purl: () => string;
  /** Why `name` cannot be an alias's install name, if it cannot. */
  aliasProblem: string | undefined;
}): Requirement {
  const { dependerNodeId, name, spec, specKind, kind, endpoint, path } = input;
  const tag = spec.trim();
  // Same keys in the same order as a range's requirement.
  const requirement = (
    optional: boolean,
    data: Record<string, string>,
    losses: Requirement['semanticLoss'],
  ): Requirement => ({
    id: `${dependerNodeId}:${kind}:${name}`,
    dependerNodeId,
    expression: { type: 'package', purl: input.purl() },
    kind,
    optional,
    source: sourceRef('npm', endpoint),
    authority: 'native',
    raw: { path, range: spec },
    nativeSemantics: { version: 'npm-v1', data },
    semanticLoss: losses,
  });
  const dependencyField = input.dependencyField;
  if (
    specKind === 'tag' &&
    input.followed &&
    tag !== '' &&
    encodeURIComponent(tag) === tag
  )
    return requirement(
      input.optional,
      { dependencyField, range: tag, specKind },
      [],
    );
  if (input.enforced)
    throw new ProviderError(
      'UNSUPPORTED_DEPENDENCY_SPEC',
      `${input.owner} depends on ${name} as "${spec}", a ${specKind} specifier ` +
        `that is not a registry version range` +
        (input.aliasProblem === undefined ? '' : ` (${input.aliasProblem})`),
    );
  return requirement(true, { dependencyField, range: spec, specKind }, [
    semanticLoss(
      'npm',
      'NPM_DEPENDENCY_SPEC_NOT_A_RANGE',
      path,
      `The ${specKind} specifier "${spec}" is not a registry version range`,
      'The package is named without a version constraint and the specifier is retained verbatim',
      'info',
    ),
  ]);
}
