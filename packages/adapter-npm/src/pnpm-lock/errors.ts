/**
 * What `pnpm-lock.yaml` reading refuses, and why.
 *
 * Every refusal is a `ProviderError` with the code `INVALID_LOCKFILE`, the code
 * the `package-lock.json` reader uses, so a caller that already handles one
 * handles both. `reason` says which rule refused, so a test and a policy can
 * tell a lock that is too big from one that is malformed without reading the
 * message.
 */

import { ProviderError } from '@openpacker/adapter-core';

export type PnpmLockReason =
  /** Input larger than `maxBytes`. */
  | 'too-large'
  /** Any other bound: nodes, depth, entries, key length, peer nesting. */
  | 'limit'
  /** Not UTF-8, or a character YAML does not allow. */
  | 'encoding'
  /** Unresolved merge conflict markers. */
  | 'conflict-markers'
  /** The text is not YAML, or not one document. */
  | 'yaml-syntax'
  /** An anchor, alias, tag, merge key or directive: pnpm writes none. */
  | 'yaml-feature'
  /** A mapping lists a key twice. */
  | 'duplicate-key'
  /** A value of the wrong type or in the wrong place. */
  | 'shape'
  /** A key pnpm does not write in that place. */
  | 'unknown-key'
  /** `lockfileVersion` other than `'9.0'`. */
  | 'version'
  /** A `name@version(peers)` key or value that does not parse. */
  | 'dep-path'
  /** A package name that cannot be a directory under `node_modules`. */
  | 'name'
  /** An `integrity` that is not a well formed digest. */
  | 'integrity'
  /** A path that is absolute, escapes the project, or holds a control character. */
  | 'unsafe-path'
  /** A URL that is malformed or carries credentials. */
  | 'url'
  /** The lock disagrees with itself (see `validatePnpmLock`). */
  | 'inconsistent';

export class PnpmLockError extends ProviderError {
  constructor(
    readonly reason: PnpmLockReason,
    message: string,
    /** Where in the lock, e.g. `packages["a@1.0.0"].resolution`; empty for the whole file. */
    readonly where: string = '',
  ) {
    super(
      'INVALID_LOCKFILE',
      where === ''
        ? `pnpm-lock.yaml ${message}`
        : `pnpm-lock.yaml ${where} ${message}`,
    );
    this.name = 'PnpmLockError';
  }
}

/** A path into the lock, spelled so a key with dots or slashes stays one step. */
export function at(where: string, key: string): string {
  return where === '' ? key : `${where}[${JSON.stringify(key)}]`;
}

/** The step to a field, `where.field`. */
export function field(where: string, name: string): string {
  return where === '' ? name : `${where}.${name}`;
}
