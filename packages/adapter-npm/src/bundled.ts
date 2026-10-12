/**
 * Dependencies a package ships inside its own archive.
 *
 * `bundleDependencies` names packages whose files are in the published
 * tarball, under the package's own `node_modules`. npm never resolves them
 * (`@npmcli/arborist` takes "whatever is specified" for a bundled edge) and an
 * install of the tarball puts them there. `npm` itself bundles all 68 of its
 * dependencies.
 */

import type { Requirement } from '@openpacker/contracts';
import { semanticLoss } from '@openpacker/adapter-core';

interface BundleFields {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

/**
 * The dependency names a version bundles. Both spellings npm accepts; `true`
 * means every name in `dependencies`; anything else names nothing.
 */
export function bundledDependencyNames(metadata: BundleFields): Set<string> {
  const declared = metadata.bundleDependencies ?? metadata.bundledDependencies;
  if (declared === true)
    return new Set(Object.keys(metadata.dependencies ?? {}));
  if (!Array.isArray(declared)) return new Set();
  return new Set(
    declared.filter((name): name is string => typeof name === 'string'),
  );
}

/**
 * The requirement as the solve sees a bundled edge: recorded, with the reason,
 * and not a requirement. It stays `optional` so the solver ignores it, and the
 * native data says it is bundled so nothing mistakes it for an optional
 * dependency.
 */
export function asBundled(requirement: Requirement, path: string): Requirement {
  const data =
    requirement.nativeSemantics?.data !== null &&
    typeof requirement.nativeSemantics?.data === 'object' &&
    !Array.isArray(requirement.nativeSemantics.data)
      ? requirement.nativeSemantics.data
      : {};
  return {
    ...requirement,
    optional: true,
    nativeSemantics: {
      version: requirement.nativeSemantics?.version ?? 'npm-v1',
      data: { ...data, bundled: true },
    },
    semanticLoss: [
      ...requirement.semanticLoss,
      semanticLoss(
        'npm',
        'NPM_DEPENDENCY_BUNDLED',
        path,
        'The dependency ships inside the package archive',
        'It is installed from the archive and is not resolved from the registry',
        'info',
      ),
    ],
  };
}
