/**
 * The lists derived from a model are a function of what the lock holds. A
 * `PnpmLock` the reader returns is already sorted, so reading a file with its
 * entries in another order proves nothing about these functions; a model built
 * (or reordered) by hand does.
 */

import { describe, expect, it } from 'vitest';
import { exoticSourcesOf } from './exotic.js';
import { parsePnpmLock } from './parse.js';
import { SHA512 } from './read-support.test-helpers.js';
import { summarizePnpmLock } from './summary.js';
import type { PnpmLock } from './types.js';
import { validatePnpmLock } from './validate.js';

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.9.0
        version: 1.9.0
      a-b:
        specifier: ^2.0.0
        version: 2.0.0

packages:

  a-b@1.0.0:
    resolution: {integrity: ${SHA512}}
    os: [linux]

  a-b@2.0.0:
    resolution: {integrity: ${SHA512}}
    cpu: [arm64]

  a@1.10.0:
    resolution: {integrity: ${SHA512}}

  a@1.9.0:
    resolution: {integrity: ${SHA512}}
    os: [darwin]

  o@1.0.0:
    resolution: {integrity: ${SHA512}}

  p@1.0.0:
    resolution: {integrity: ${SHA512}}

  t@https://h/t.tgz:
    resolution: {tarball: "https://h/t.tgz"}
    version: 1.0.0

  u@https://h/u.tgz:
    resolution: {tarball: "https://h/u.tgz"}
    version: 1.0.0

snapshots:

  a-b@1.0.0: {}

  a-b@2.0.0: {}

  a@1.10.0: {}

  a@1.9.0: {}

  t@https://h/t.tgz: {}

  u@https://h/u.tgz: {}
`;

/** The same lock with every list the reader sorted written the other way round. */
function reversed(lock: PnpmLock): PnpmLock {
  return {
    ...lock,
    importers: [...lock.importers].reverse(),
    packages: [...lock.packages].reverse(),
    snapshots: [...lock.snapshots].reverse(),
  };
}

describe('lists derived from a model', () => {
  const lock = parsePnpmLock(LOCK);
  const shuffled = reversed(lock);

  it('is a model whose lists really are the other way round', () => {
    expect(shuffled.packages.map((pkg) => pkg.key)).not.toEqual(
      lock.packages.map((pkg) => pkg.key),
    );
    expect(shuffled.packages.map((pkg) => pkg.key)[0]).toBe(
      'u@https://h/u.tgz',
    );
  });

  it('lists names held in several versions by name, and each name’s versions in code unit order', () => {
    // `a` before `a-b` although the key `a-b@…` sorts before `a@…` ('-' is below '@'),
    // and 1.10.0 before 1.9.0 because the order is the code units', not semver's.
    const expected = [
      { name: 'a', versions: ['1.10.0', '1.9.0'] },
      { name: 'a-b', versions: ['1.0.0', '2.0.0'] },
    ];
    expect(summarizePnpmLock(lock).multiVersionNames).toEqual(expected);
    expect(summarizePnpmLock(shuffled).multiVersionNames).toEqual(expected);
  });

  it('lists the platform restrictions by key', () => {
    const expected = ['a-b@1.0.0', 'a-b@2.0.0', 'a@1.9.0'];
    expect(
      summarizePnpmLock(lock).platformRestricted.map((r) => r.key),
    ).toEqual(expected);
    expect(
      summarizePnpmLock(shuffled).platformRestricted.map((r) => r.key),
    ).toEqual(expected);
  });

  it('summarises a model to the same value whatever order it was built in', () => {
    expect(summarizePnpmLock(shuffled)).toEqual(summarizePnpmLock(lock));
  });

  it('lists the exotic sources by key', () => {
    const keys = exoticSourcesOf(shuffled).map((source) => source.key);
    expect(keys).toEqual(['t@https://h/t.tgz', 'u@https://h/u.tgz']);
    expect(exoticSourcesOf(shuffled)).toEqual(exoticSourcesOf(lock));
  });

  it('lists the orphans by key', () => {
    const report = validatePnpmLock(lock);
    expect(report.orphanPackages).toEqual(['o@1.0.0', 'p@1.0.0']);
    expect(report.orphanSnapshots).toEqual([
      'a-b@1.0.0',
      'a@1.10.0',
      't@https://h/t.tgz',
      'u@https://h/u.tgz',
    ]);
    const other = validatePnpmLock(shuffled);
    expect(other.orphanPackages).toEqual(report.orphanPackages);
    expect(other.orphanSnapshots).toEqual(report.orphanSnapshots);
  });
});
