import { canonicalPurlOrSelf } from './catalog.js';
import { stripPurlVersion } from './spec.js';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';

/**
 * A label in opm.toml names one package. Adding to the project under a label
 * that already names the same package is an update of that requirement; under a
 * label that names another package it would replace a requirement the person
 * did not mention (`opm add is-number@npm:is-odd` over `is-number`), so it is
 * refused and says how to proceed. ADR 0054.
 */
export function assertLabelIsFree(
  manifest: OpmManifest,
  label: string,
  purl: string,
): void {
  const existing = manifest.packages[label];
  if (existing === undefined) return;
  const held = canonicalPurlOrSelf(stripPurlVersion(existing.purl));
  const asked = canonicalPurlOrSelf(stripPurlVersion(purl));
  if (held === asked) return;
  throw new OpmError(
    'INVALID_SPEC',
    `"${label}" already names ${held} in opm.toml, and this would make it ${asked}: ` +
      `remove it first (opm remove ${label}), or give this one another label with --alias`,
  );
}
