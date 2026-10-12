/**
 * The value a dependency points at: what an importer's `version` and a
 * snapshot's `dependencies` entries hold.
 *
 * ```
 * 18.2.0                              a version of the package under that name
 * 18.2.0(react@18.2.0)                 the same, resolved against these peers
 * string-width@4.2.3                   an alias: another package, installed under this name
 * link:../packages/runtime             a directory, linked and not installed
 * file:../vendor/a   https://h/a.tgz   other sources, each a snapshot of its own
 * ```
 *
 * Whether a value is an alias is decided as pnpm does (`refToRelative` in
 * `@pnpm/dependency-path`): it is already a full `name@version` when it
 * starts with `@`, or when its first `@` comes before any `:` and any `(`.
 * Otherwise the dependency's own name is put in front, and the result is the key
 * of the snapshot it resolves to.
 */

import { PnpmLockError } from './errors.js';
import { parseDepPath, type DepPath } from './dep-path.js';
import type { PnpmLockLimits } from './limits.js';
import { relativePathProblem } from './source.js';

/** `link:<path>`: a directory the dependency name is linked to. Nothing is installed for it. */
export interface LinkRef {
  readonly kind: 'link';
  readonly raw: string;
  /** The path after `link:`, relative to the importer (or snapshot's package) that lists it. */
  readonly target: string;
}

/** A package in `snapshots`. */
export interface DepRef {
  readonly kind: 'dep';
  readonly raw: string;
  /** The value spelled its own package name (`npm:` alias), so the dependency name is not the package's. */
  readonly aliased: boolean;
  /** The snapshot key it resolves to, parsed; `target.raw` is that key. */
  readonly target: DepPath;
}

export type PnpmRef = LinkRef | DepRef;

/** Is `raw` already `name@version`, as pnpm's `refToRelative` decides. */
function isFullDepPath(raw: string): boolean {
  if (raw.startsWith('@')) return true;
  const at = raw.indexOf('@');
  if (at === -1) return false;
  const colon = raw.indexOf(':');
  const bracket = raw.indexOf('(');
  return (colon === -1 || at < colon) && (bracket === -1 || at < bracket);
}

/** Read the value a dependency named `name` points at; `where` is its place in the lock. */
export function parseRef(
  name: string,
  raw: string,
  limits: PnpmLockLimits,
  where: string,
): PnpmRef {
  if (raw.startsWith('link:')) {
    const target = raw.slice(5);
    const problem = relativePathProblem(target);
    if (problem !== undefined)
      throw new PnpmLockError('unsafe-path', `link: target ${problem}`, where);
    return { kind: 'link', raw, target };
  }
  const aliased = isFullDepPath(raw);
  const key = aliased ? raw : `${name}@${raw}`;
  return {
    kind: 'dep',
    raw,
    aliased,
    target: parseDepPath(key, limits, where),
  };
}
