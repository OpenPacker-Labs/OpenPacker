import { describe, expect, it } from 'vitest';
import {
  installedClosure,
  type InstalledPackageRecord,
  type LockPackage,
  type OpmLockfile,
  type ProjectState,
} from '../src/index.js';

/**
 * Which packages an installed npm bin runs with, and which each requires: the
 * lock's closure of its package when the lock describes what is installed, and
 * every npm package installed, by name alone, when it does not.
 */

const digestOf = (key: string) =>
  `sha256:${Buffer.from(key).toString('hex').padEnd(64, '0').slice(0, 64)}`;

function entry(
  key: string,
  purl: string,
  edges?: { dependencies: string[]; aliases?: Record<string, string> },
): LockPackage {
  return {
    alias: key,
    purl,
    version: purl.slice(purl.lastIndexOf('@') + 1),
    digest: digestOf(key),
    size: 10,
    format: 'tar+gzip',
    mediaType: 'application/gzip',
    source: `https://registry.example/${key}.tgz`,
    storeKey: digestOf(key).replace(':', '-'),
    bins: [],
    reason: 'transitive',
    ecosystem: 'npm',
    ...edges,
  };
}

const lockOf = (...entries: LockPackage[]): OpmLockfile => ({
  schemaVersion: 1,
  generatedBy: 'opm',
  packages: Object.fromEntries(entries.map((pkg) => [pkg.alias, pkg])),
});

/** What the active generation installed: each lock entry, as the lock says. */
function stateOf(lock: OpmLockfile, extra: InstalledPackageRecord[] = []) {
  const state: ProjectState = { schemaVersion: 1, packages: {} };
  for (const record of [
    ...Object.values(lock.packages).map(
      (pkg): InstalledPackageRecord => ({
        alias: pkg.alias,
        purl: pkg.purl,
        digest: pkg.digest,
        storePath: `/store/${pkg.alias}`,
        bins: [],
        installedAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    ...extra,
  ])
    state.packages[record.alias] = record;
  return state;
}

/** `runner` requires `helper@1` and `wrap` (as `strip-cjs`); the project holds `helper@2` too. */
const lock = () =>
  lockOf(
    entry('runner', 'pkg:npm/runner@1.0.0', {
      dependencies: ['helper.1.0.0'],
      aliases: { 'strip-cjs': 'strip' },
    }),
    entry('helper.1.0.0', 'pkg:npm/helper@1.0.0', { dependencies: ['ms'] }),
    entry('ms', 'pkg:npm/ms@2.1.3', { dependencies: [] }),
    entry('strip', 'pkg:npm/strip@6.0.1', { dependencies: [] }),
    entry('helper', 'pkg:npm/helper@2.0.0', { dependencies: [] }),
  );

describe('installedClosure', () => {
  it('is the closure the lock records, each package told what it requires', () => {
    const made = lock();
    const { tool, closure } = installedClosure(made, stateOf(made), 'runner');
    expect(tool).toBe('pkg:npm/runner@1.0.0');
    expect(
      closure.map((pkg) => [pkg.exactPurl, pkg.storePath, pkg.requires]),
    ).toEqual([
      [
        'pkg:npm/runner@1.0.0',
        '/store/runner',
        { helper: 'pkg:npm/helper@1.0.0', 'strip-cjs': 'pkg:npm/strip@6.0.1' },
      ],
      [
        'pkg:npm/helper@1.0.0',
        '/store/helper.1.0.0',
        { ms: 'pkg:npm/ms@2.1.3' },
      ],
      ['pkg:npm/strip@6.0.1', '/store/strip', {}],
      ['pkg:npm/ms@2.1.3', '/store/ms', {}],
    ]);
    expect(closure[0]).toMatchObject({
      digest: digestOf('runner'),
      size: 10,
      source: 'https://registry.example/runner.tgz',
    });
  });

  it('is every npm package installed, by name, when the lock is of another install', () => {
    const made = lock();
    const state = stateOf(made, [
      {
        alias: 'tool',
        purl: 'pkg:pypi/tool@1.0',
        digest: digestOf('tool'),
        storePath: '/store/tool',
        bins: [],
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // After `opm rollback`: the generation holds another ms than the lock.
    state.packages.ms = { ...state.packages.ms!, digest: digestOf('older') };
    const { tool, closure } = installedClosure(made, state, 'runner');
    expect(tool).toBe('pkg:npm/runner@1.0.0');
    expect(closure.map((pkg) => [pkg.exactPurl, pkg.requires])).toEqual(
      Object.values(made.packages).map((pkg) => [pkg.purl, undefined]),
    );
    expect(closure.find((pkg) => pkg.exactPurl.includes('/ms@'))).toEqual({
      exactPurl: 'pkg:npm/ms@2.1.3',
      digest: digestOf('older'),
      size: 0,
      source: 'pkg:npm/ms@2.1.3',
      storePath: '/store/ms',
    });
  });

  it('is every npm package installed, by name, when the lock records no edges', () => {
    const made = lockOf(entry('runner', 'pkg:npm/runner@1.0.0'));
    const { closure } = installedClosure(made, stateOf(made), 'runner');
    expect(closure).toEqual([
      {
        exactPurl: 'pkg:npm/runner@1.0.0',
        digest: digestOf('runner'),
        size: 10,
        source: 'https://registry.example/runner.tgz',
        storePath: '/store/runner',
      },
    ]);
  });

  it('is laid out by name with no lock, and refuses a package not installed', () => {
    const made = lock();
    expect(
      installedClosure(undefined, stateOf(made), 'runner').closure,
    ).toHaveLength(5);
    expect(() => installedClosure(made, stateOf(made), 'nope')).toThrow(
      /nope is not installed/u,
    );
  });
});
