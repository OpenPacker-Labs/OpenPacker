/**
 * The bounds on reading a `pnpm-lock.yaml`.
 *
 * A lock is input from a repository, and `opm` reads it before it has decided
 * to trust anything in it, so every dimension that costs memory or time has a
 * ceiling, and exceeding one is a refusal that names the number.
 *
 * The defaults sit about ten times above the largest real lock measured (HoBo:
 * 792 importers, 2,160 packages, 2,193 snapshots, 0.8 MB, 0.6 s, 146 MB resident)
 * and are set by what the reader costs: 0.74 s and 73 MB of resident memory per
 * megabyte of a realistic lock (6.5 MB took 4.8 s and 478 MB; 13 MB took 9.6 s
 * and 951 MB), about 1 s and 90 MB per megabyte of one that is all tiny entries
 * (8.3 MB took 8.8 s and 758 MB). The byte ceiling keeps the worst case near
 * 9 s and 800 MB; a project with a larger lock raises the number it names.
 */

import { PnpmLockError } from './errors.js';

export interface PnpmLockLimits {
  /** Size of the text in bytes. */
  readonly maxBytes: number;
  /** YAML nodes: scalars, mappings and sequences, keys included. */
  readonly maxNodes: number;
  /** Nesting of YAML collections. pnpm writes at most 8. */
  readonly maxDepth: number;
  /** Entries under `importers`. */
  readonly maxImporters: number;
  /** Entries under `packages`. */
  readonly maxPackages: number;
  /** Entries under `snapshots`; one package has one per peer set it was resolved against. */
  readonly maxSnapshots: number;
  /** Entries in any one other mapping or list (one importer's dependencies, `os`, `overrides`). */
  readonly maxEntries: number;
  /** Characters in a key, a version reference or a dependency path. */
  readonly maxKeyLength: number;
  /** Characters in any other string (a deprecation message is the longest real one). */
  readonly maxStringLength: number;
  /** Nesting of the `(peer@1.0.0(peer@2.0.0))` groups in one dependency path. */
  readonly maxPeerDepth: number;
  /** Groups in one dependency path, counted through every level. */
  readonly maxPeerGroups: number;
}

export const DEFAULT_PNPM_LOCK_LIMITS: PnpmLockLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxNodes: 1_000_000,
  maxDepth: 16,
  maxImporters: 20_000,
  maxPackages: 100_000,
  maxSnapshots: 200_000,
  maxEntries: 50_000,
  maxKeyLength: 8192,
  maxStringLength: 65_536,
  maxPeerDepth: 32,
  maxPeerGroups: 512,
};

/** The defaults with the caller's overrides; a bound that is not a positive integer is refused. */
export function resolvePnpmLockLimits(
  overrides: Partial<PnpmLockLimits> = {},
): PnpmLockLimits {
  const limits = { ...DEFAULT_PNPM_LOCK_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new PnpmLockError(
        'limit',
        `the limit ${name} must be a positive integer, received ${String(value)}`,
      );
  return limits;
}

/** Refuse `actual` when it is over `limit`; `what` names what was counted and `name` the limit to raise. */
export function checkLimit(
  actual: number,
  limit: number,
  what: string,
  name: keyof PnpmLockLimits,
  where = '',
): void {
  if (actual > limit)
    throw new PnpmLockError(
      'limit',
      `has ${actual} ${what}, more than the limit of ${limit} (${name})`,
      where,
    );
}
