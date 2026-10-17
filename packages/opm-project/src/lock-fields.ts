import type { LockPackage } from './types.js';
import { OpmError } from './types.js';

/** Fields of a lock entry that carry a shape of their own, parsed on their own. */

const LIFECYCLE_STATUSES = new Set([
  'published',
  'yanked',
  'deprecated',
  'quarantined',
  'revoked',
  'delisted',
  'restored',
  'promoted',
  'removed-from-channel',
  'ownership-transferred',
  'unknown',
]);

/**
 * `built` with its fields in the order the file wrote them (any it did not
 * write last), so a lock read and written again is the lock that was read.
 * Locks written before `aliases` existed kept `dependencies` after the supply
 * chain fields; re-ordering them would be a diff nobody made.
 */
export function inFileOrder(
  built: LockPackage,
  order: readonly string[],
): LockPackage {
  const fields = new Map(Object.entries(built));
  const written = order.filter((key) => fields.has(key));
  const rest = [...fields.keys()].filter((key) => !order.includes(key));
  // SAFETY: the same fields as `built`, in the order the file wrote them.
  return Object.fromEntries(
    [...written, ...rest].map((key) => [key, fields.get(key)]),
  ) as unknown as LockPackage;
}

export function parseAliases(
  alias: string,
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid aliases`,
    );
  const entries = Object.entries(value);
  if (entries.length === 0)
    throw new OpmError('INVALID_LOCK', `Package "${alias}" has empty aliases`);
  for (const [name, key] of entries)
    if (name === '' || typeof key !== 'string' || key === '')
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${alias}" has an invalid alias ${JSON.stringify(name)}`,
      );
  return Object.fromEntries(
    entries.sort(([left], [right]) => (left < right ? -1 : 1)),
  ) as Record<string, string>;
}

/** The name a direct entry is installed under, when it is not its own. */
export function parseInstallName(
  alias: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '')
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid installName`,
    );
  return value;
}

export function isNativeIntegrity(
  value: unknown,
): value is NonNullable<LockPackage['nativeIntegrity']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const integrity = value as Record<string, unknown>;
  return (
    typeof integrity.algorithm === 'string' &&
    integrity.algorithm !== '' &&
    typeof integrity.value === 'string' &&
    integrity.value !== '' &&
    typeof integrity.encoding === 'string' &&
    integrity.encoding !== ''
  );
}

export function isLifecycleState(
  value: unknown,
): value is NonNullable<LockPackage['lifecycle']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const lifecycle = value as Record<string, unknown>;
  return (
    typeof lifecycle.eligible === 'boolean' &&
    typeof lifecycle.status === 'string' &&
    LIFECYCLE_STATUSES.has(lifecycle.status)
  );
}
