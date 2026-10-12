import { describe, expect, it } from 'vitest';
import { parsePnpmLock } from './parse.js';
import { DEFAULT_PNPM_LOCK_LIMITS, type PnpmLockLimits } from './limits.js';
import {
  BASE,
  SHA512,
  edit,
  pkgField,
  refusalOf,
} from './read-support.test-helpers.js';
import { LEXEMES_PER_NODE } from './yaml-tree.js';

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

describe('the default bounds', () => {
  // The largest real lock (HoBo's) is 825,879 bytes, 46,862 YAML nodes and
  // 159,674 lexemes. These are the figures the ADR and limits.ts state their
  // worst case (about 5 s and 500 MB) from; change one and measure again.
  it('are ten to sixteen times that, and no more', () => {
    const { maxBytes, maxNodes } = DEFAULT_PNPM_LOCK_LIMITS;
    expect(maxBytes).toBe(8 * 1024 * 1024);
    expect(maxNodes).toBe(500_000);
    expect(maxNodes * LEXEMES_PER_NODE).toBe(2_500_000);
    expect(maxBytes / 825_879).toBeCloseTo(10.2, 1);
    expect(maxNodes / 46_862).toBeCloseTo(10.7, 1);
    expect((maxNodes * LEXEMES_PER_NODE) / 159_674).toBeCloseTo(15.7, 1);
  });
});
