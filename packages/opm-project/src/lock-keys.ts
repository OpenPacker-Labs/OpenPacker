import type { PackageInstance } from '@openpacker/contracts';
import { codecFor } from './codecs.js';

/**
 * The key a lock entry is stored under.
 *
 * A key is one safe path segment (it names a link file and a state record), it
 * is unique in the lock, and for a closure that selects each package name once
 * it is what it has always been: the name with `/` and the characters outside
 * `[A-Za-z0-9._-]` written as `-`. A name selected at several versions has no
 * such key, so each version is `<name>.<version>` (the same character rule); a
 * direct requirement keeps its manifest alias. A collision with any key already
 * taken takes a numeric suffix, in sorted order, so the same selection always
 * gets the same keys. See ADR 0054.
 */

/** The key a package had before several versions were possible. */
export function flatLockName(exactPurl: string): string {
  const withoutScheme = exactPurl.slice('pkg:'.length);
  const withoutVersion = withoutScheme.split('@')[0]!;
  const name = withoutVersion.split('/').slice(1).join('-');
  return (name || withoutVersion).replace(/[^A-Za-z0-9._-]/gu, '-');
}

function flatVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/[. ]+$/u, '');
}

/** What a key is allocated for: one release in a closure. */
export interface KeyedRelease {
  /** What the caller knows it by; the result is keyed by this. */
  id: string;
  /** The package, without a version. */
  canonicalPurl: string;
  /** The release, with its version. */
  exactPurl: string;
  version: string;
  ecosystem: string;
}

/**
 * A key for every selected package.
 *
 * `directKeys` is the exact PURL of each direct requirement and the manifest
 * alias it is locked under; those are not changed.
 */
export function allocateLockKeys(input: {
  selected: readonly PackageInstance[];
  directKeys: ReadonlyMap<string, string>;
}): Map<string, string> {
  return allocateKeys({
    releases: input.selected.map((instance) => ({
      id: instance.nodeId,
      canonicalPurl: instance.identity.canonicalPurl,
      exactPurl: instance.identity.exactPurl ?? '',
      version: instance.nativeVersion,
      ecosystem: instance.identity.purlType,
    })),
    directKeys: input.directKeys,
  });
}

/** The same allocation, over releases however the caller holds them. */
export function allocateKeys(input: {
  releases: readonly KeyedRelease[];
  directKeys: ReadonlyMap<string, string>;
}): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set(input.directKeys.values());
  const count = new Map<string, number>();
  for (const release of input.releases)
    count.set(
      release.canonicalPurl,
      (count.get(release.canonicalPurl) ?? 0) + 1,
    );
  const transitive: KeyedRelease[] = [];
  for (const release of input.releases) {
    const direct = input.directKeys.get(release.exactPurl);
    if (direct !== undefined) keys.set(release.id, direct);
    else transitive.push(release);
  }
  const ordered = [...transitive].sort((left, right) => {
    if (left.canonicalPurl !== right.canonicalPurl)
      return left.canonicalPurl < right.canonicalPurl ? -1 : 1;
    return codecFor(left.ecosystem).compareNativeVersions(
      left.version,
      right.version,
    );
  });
  for (const release of ordered) {
    const plain = flatLockName(release.exactPurl);
    const several = (count.get(release.canonicalPurl) ?? 1) > 1;
    const base = several ? `${plain}.${flatVersion(release.version)}` : plain;
    let key = base;
    for (let suffix = 2; taken.has(key); suffix += 1) key = `${base}.${suffix}`;
    taken.add(key);
    keys.set(release.id, key);
  }
  return keys;
}
