import type { JsonValue } from '@openpacker/contracts';
import { serializeLockfile } from './lock.js';
import type { OpmLockfile } from './types.js';

/**
 * A lock reduced to what a fresh resolution of the same manifest must
 * reproduce.
 *
 * Attestation state that advances by itself — a signed list's sequence rises
 * with every release the vendor publishes — differs between resolutions
 * without the release changing, so it is left out. Which keys advance is taken
 * from `reference`, the fresh resolution, never from the lock under
 * verification: an edited lock cannot excuse its own differences.
 */
export function reproducibleLockForm(
  lock: OpmLockfile,
  reference: OpmLockfile,
): JsonValue {
  const packages = Object.fromEntries(
    Object.entries(lock.packages).map(([alias, pkg]) => {
      if (pkg.attestation === undefined) return [alias, pkg];
      const skipped = new Set(
        reference.packages[alias]?.attestation?.advancing ?? [],
      );
      const record = Object.fromEntries(
        Object.entries(pkg.attestation.record).filter(
          ([key]) => !skipped.has(key),
        ),
      );
      // The list of advancing keys is the provider's description of its own
      // record, not a fact about the release, so it is not compared either.
      const { advancing: _described, ...attestation } = pkg.attestation;
      return [alias, { ...pkg, attestation: { ...attestation, record } }];
    }),
  );
  // SAFETY: serializeLockfile writes JSON.
  return JSON.parse(serializeLockfile({ ...lock, packages })) as JsonValue;
}
