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
  const keys = new Map<string, string>();
  const taken = new Set(input.directKeys.values());
  const count = new Map<string, number>();
  for (const instance of input.selected)
    count.set(
      instance.identity.canonicalPurl,
      (count.get(instance.identity.canonicalPurl) ?? 0) + 1,
    );
  const transitive: PackageInstance[] = [];
  for (const instance of input.selected) {
    const direct = input.directKeys.get(instance.identity.exactPurl ?? '');
    if (direct !== undefined) keys.set(instance.nodeId, direct);
    else transitive.push(instance);
  }
  const ordered = [...transitive].sort((left, right) => {
    if (left.identity.canonicalPurl !== right.identity.canonicalPurl)
      return left.identity.canonicalPurl < right.identity.canonicalPurl
        ? -1
        : 1;
    return codecFor(left.identity.purlType).compareNativeVersions(
      left.nativeVersion,
      right.nativeVersion,
    );
  });
  for (const instance of ordered) {
    const exact = instance.identity.exactPurl!;
    const plain = flatLockName(exact);
    const several = (count.get(instance.identity.canonicalPurl) ?? 1) > 1;
    const base = several
      ? `${plain}.${flatVersion(instance.nativeVersion)}`
      : plain;
    let key = base;
    for (let suffix = 2; taken.has(key); suffix += 1) key = `${base}.${suffix}`;
    taken.add(key);
    keys.set(instance.nodeId, key);
  }
  return keys;
}
