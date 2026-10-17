import { allocateKeys, type KeyedRelease } from './lock-keys.js';
import { stripPurlVersion } from './spec.js';
import type { LockPackage, OpmLockfile } from './types.js';

/**
 * Keys after an entry has been taken out of a lock.
 *
 * A key says whether its name is held once (`tinybench`) or at several
 * versions (`tinybench.2.9.0`), so removing the one version that made it two
 * leaves a key a fresh resolve would not write, and `opm install` compares the
 * lock with a fresh resolve. `rekeyTransitive` gives every dependency the key
 * the allocation of a resolve would, from what the lock now holds; a direct
 * requirement keeps its manifest alias. ADR 0054.
 */

/** Old key → new key, for each dependency whose key changes. */
export function rekeyTransitive(lock: OpmLockfile): Map<string, string> {
  const directKeys = new Map<string, string>();
  const releases: KeyedRelease[] = [];
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.reason === 'direct' && !directKeys.has(pkg.purl))
      directKeys.set(pkg.purl, key);
    releases.push({
      id: key,
      canonicalPurl: stripPurlVersion(pkg.purl),
      exactPurl: pkg.purl,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
    });
  }
  const renamed = new Map<string, string>();
  for (const [id, key] of allocateKeys({ releases, directKeys }))
    if (key !== id && lock.packages[id]?.reason === 'transitive')
      renamed.set(id, key);
  return renamed;
}

/** Write the new keys into the lock: the entries, and every edge to them. */
export function applyKeys(
  lock: OpmLockfile,
  renamed: ReadonlyMap<string, string>,
): void {
  if (renamed.size === 0) return;
  const rename = (key: string): string => renamed.get(key) ?? key;
  // New objects, not edited ones: an entry the resolve bound to its bytes is
  // frozen.
  lock.packages = Object.fromEntries(
    Object.entries(lock.packages).map(([key, pkg]): [string, LockPackage] => [
      rename(key),
      {
        ...pkg,
        alias: rename(key),
        ...(pkg.dependencies !== undefined && {
          dependencies: [...new Set(pkg.dependencies.map(rename))].sort(),
        }),
        ...(pkg.aliases !== undefined && {
          aliases: Object.fromEntries(
            Object.entries(pkg.aliases).map(([name, target]) => [
              name,
              rename(target),
            ]),
          ),
        }),
      },
    ]),
  );
}
