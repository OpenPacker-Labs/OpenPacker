/**
 * The bounds on reading a `pnpm-lock.yaml`.
 *
 * A lock is input from a repository, and `opm` reads it before it has decided
 * to trust anything in it, so every dimension that costs memory or time has a
 * ceiling, and exceeding one is a refusal that names the number.
 *
 * The defaults sit about ten times above the largest real lock measured (HoBo:
 * 825,879 bytes, 46,862 YAML nodes, 159,674 lexemes, 792 importers, 2,160
 * packages, 2,193 snapshots; read in 0.7 s at 146 MB resident, of which 77 MB
 * is node): 8 MiB is 10.2 times its bytes, 500,000 nodes 10.7 times its nodes,
 * and the lexeme budget (five a node, so 2.5 million) 15.7 times its lexemes.
 *
 * Reading costs about 0.6 s and 55 MB per megabyte of a lock of HoBo's kind:
 * 7.9 MB of it (HoBo's packages and snapshots eleven times over, 450,432 nodes)
 * takes 4.0 to 5.6 s and 500 MB. Input built to cost the most per byte (blank
 * lines, empty list items, comments, tiny flow entries, tiny block entries) is
 * refused at the lexeme budget after 3 to 5 s and at most 492 MB. The first
 * defaults (1,000,000 nodes, six lexemes a node) refused the worst of them
 * only after 11.6 s and 969 MB (12.6 s and 1.24 GB in an independent run).
 * Every figure is a fresh process per input on a shared 4-CPU machine (peak
 * resident memory from `process.resourceUsage().maxRSS`); a project with a
 * larger lock raises the number the refusal names.
 */

import { PnpmLockError } from './errors.js';

export interface PnpmLockLimits {
  /** Size of the text in bytes. */
  readonly maxBytes: number;
  /** YAML nodes: scalars, mappings and sequences, keys included. */
  readonly maxNodes: number;
  /** Nesting of YAML collections: real locks nest 5, a runtime's variants 8. */
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
  maxNodes: 500_000,
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
