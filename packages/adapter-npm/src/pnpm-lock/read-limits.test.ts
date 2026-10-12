import { describe, expect, it } from 'vitest';
import { parsePnpmLock } from './parse.js';
import type { PnpmLockLimits } from './limits.js';
import {
  BASE,
  SHA512,
  edit,
  pkgField,
  refusalOf,
} from './read-support.test-helpers.js';

const importersTwo = () => edit(BASE, '  .:\n', '  packages/b: {}\n\n  .:\n');
const packagesTwo = () =>
  edit(
    BASE,
    '\nsnapshots:',
    `\n  b@1.0.0:\n    resolution: {integrity: ${SHA512}}\n\nsnapshots:`,
  );
const snapshotsTwo = () => `${BASE}\n  b@1.0.0: {}\n`;
const dependenciesTwo = () =>
  edit(
    BASE,
    '    dependencies:\n      a:',
    '    dependencies:\n      b:\n        specifier: ^1.0.0\n        version: 1.0.0\n      a:',
  );

describe('parsePnpmLock: where a fault is', () => {
  it('names the path to it, one step per key', () => {
    const error = refusalOf(pkgField('hasBin: maybe'));
    expect(error.where).toBe('packages["a@1.0.0"].hasBin');
    expect(error.message).toContain('packages["a@1.0.0"].hasBin');
  });
});

describe('parsePnpmLock: bounds', () => {
  const cases: [keyof PnpmLockLimits, number, () => string, string][] = [
    ['maxImporters', 1, importersTwo, 'importers'],
    ['maxPackages', 1, packagesTwo, 'packages'],
    ['maxSnapshots', 1, snapshotsTwo, 'snapshots'],
    ['maxEntries', 1, dependenciesTwo, 'dependencies'],
    ['maxKeyLength', 5, () => BASE, 'characters'],
  ];

  it.each(cases)('refuses past %s = %d', (limit, value, text, fragment) => {
    const error = refusalOf(text(), { [limit]: value });
    expect(error.reason).toBe('limit');
    expect(error.message).toContain(limit);
    expect(error.message).toContain(fragment);
  });

  it('accepts exactly the limit', () => {
    expect(() =>
      parsePnpmLock(importersTwo(), { maxImporters: 2 }),
    ).not.toThrow();
    expect(() =>
      parsePnpmLock(packagesTwo(), { maxPackages: 2 }),
    ).not.toThrow();
    expect(() =>
      parsePnpmLock(snapshotsTwo(), { maxSnapshots: 2 }),
    ).not.toThrow();
    expect(() =>
      parsePnpmLock(dependenciesTwo(), { maxEntries: 2 }),
    ).not.toThrow();
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(refusalOf(BASE, { maxPackages: 0 }).message).toContain(
      'maxPackages',
    );
    expect(refusalOf(BASE, { maxBytes: -1 }).reason).toBe('limit');
  });
});
