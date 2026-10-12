/**
 * A `pnpm-lock.yaml` (lockfileVersion '9.0) read as a typed, validated, bounded
 * model. ADR 0052 says what is modelled, what is refused and how the model maps
 * onto a frozen install; this is the pure part: text in, model out, nothing
 * fetched and nothing installed.
 */

import {
  assertConsistentPnpmLock,
  validatePnpmLock,
  type PnpmLockReport,
} from './validate.js';
import { parsePnpmLock } from './parse.js';
import type { PnpmLockLimits } from './limits.js';
import type { PnpmLock } from './types.js';

export { PnpmLockError, type PnpmLockReason } from './errors.js';
export {
  DEFAULT_PNPM_LOCK_LIMITS,
  resolvePnpmLockLimits,
  type PnpmLockLimits,
} from './limits.js';
export {
  PNPM_LOCKFILE_VERSION,
  parsePnpmLock,
  readPnpmLockTree,
} from './parse.js';
export { formatDepPath, packageKeyOf, parseDepPath } from './dep-path.js';
export { parseRef } from './ref.js';
export { catalogOfSpecifier, patchedPackageName } from './specifier.js';
export { exoticSourcesOf, type PnpmExoticSource } from './exotic.js';
export {
  summarizePnpmLock,
  type PnpmEdgeCounts,
  type PnpmLockSummary,
  type PnpmPlatformRestriction,
} from './summary.js';
export {
  MAXIMUM_REPORTED_PROBLEMS,
  assertConsistentPnpmLock,
  validatePnpmLock,
  type PnpmLinkEdge,
  type PnpmLockProblem,
  type PnpmLockProblemCode,
  type PnpmLockReport,
} from './validate.js';
export type * from './types.js';

/**
 * Read a lock and require it to agree with itself: `parsePnpmLock`, then
 * `validatePnpmLock`, refusing with `inconsistent` if anything dangles. The
 * report comes back too, for the orphans, exotic sources and links it lists.
 */
export function readPnpmLock(
  input: string | Uint8Array,
  limits?: Partial<PnpmLockLimits>,
): { readonly lock: PnpmLock; readonly report: PnpmLockReport } {
  const lock = parsePnpmLock(input, limits);
  const report = validatePnpmLock(lock);
  assertConsistentPnpmLock(report);
  return { lock, report };
}
