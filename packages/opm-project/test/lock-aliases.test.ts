import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PackageInstance } from '@openpacker/contracts';
import {
  parseLockfile,
  resolveManifestToLock,
  serializeLockfile,
  type LockPackage,
  type OpmLockfile,
} from '../src/index.js';
import { lockEdgeKeys, lockEdges, reachableKeys } from '../src/lock-edges.js';
import { allocateLockKeys, flatLockName } from '../src/lock-keys.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

configureDefaultAdapters();

// Kept as `.txt` so Prettier leaves the bytes the serializer wrote alone.
const legacy = await readFile(
  new URL('./fixtures/legacy-closure.opm.lock.txt', import.meta.url),
  'utf8',
);

describe('an opm.lock.json written before aliases and several versions', () => {
  it('reads and writes again byte for byte', () => {
    expect(serializeLockfile(parseLockfile(legacy))).toBe(legacy);
  });

  it('is what the same resolve writes now', async () => {
    // The fixture was written by the build before this change, from this very
    // registry state: a closure with no alias and one version per name locks to
    // the same bytes as it did.
    const root = await mkdtemp(join(tmpdir(), 'opm-legacy-'));
    try {
      const lock = await resolveManifestToLock({
        root,
        manifest: {
          project: { name: 'legacy', ecosystems: ['npm'] },
          packages: {
            app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' },
            util: {
              alias: 'util',
              purl: 'pkg:npm/%40scope/util',
              version: '2.0.0',
            },
          },
          options: { offline: false, layout: 'opm' },
          policy: {
            allowYanked: false,
            allowQuarantined: false,
            semanticLossMaximum: 'warning',
            requiredEvidence: [],
          },
        },
        offline: false,
        registryOptions: {
          transport: new NpmRegistryFixture([
            {
              name: 'app',
              versions: {
                '1.0.0': {
                  dependencies: {
                    left: '^1',
                    right: '^1',
                    '@scope/util': '^2',
                  },
                },
              },
            },
            {
              name: 'left',
              versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } },
            },
            {
              name: 'right',
              versions: {
                '1.0.0': { dependencies: { shared: '~1.2.0', 'leaf.js': '*' } },
              },
            },
            {
              name: 'shared',
              versions: { '1.0.0': {}, '1.2.0': {}, '1.2.5': {}, '1.3.0': {} },
            },
            { name: 'leaf.js', versions: { '0.1.0': {} } },
            { name: '@scope/util', versions: { '2.0.0': {} } },
          ]),
        },
      });
      expect(serializeLockfile(lock)).toBe(legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const entry = (
  alias: string,
  extra: Partial<LockPackage> = {},
): LockPackage => ({
  alias,
  purl: `pkg:npm/${alias}@1.0.0`,
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  size: 1,
  format: 'tar+gzip',
  mediaType: 'application/gzip',
  source: `https://registry.npmjs.org/${alias}/-/${alias}-1.0.0.tgz`,
  storeKey: `sha256-${'a'.repeat(64)}`,
  bins: [],
  reason: 'transitive',
  ecosystem: 'npm',
  ...extra,
});

const lockOf = (...packages: LockPackage[]): OpmLockfile => ({
  schemaVersion: 1,
  generatedBy: 'opm',
  packages: Object.fromEntries(packages.map((item) => [item.alias, item])),
});

describe('aliases in the lock', () => {
  const aliased = lockOf(
    entry('cliui', {
      reason: 'direct',
      dependencies: ['string-width.5.1.2'],
      aliases: { 'string-width-cjs': 'string-width.4.2.3' },
    }),
    entry('string-width.4.2.3'),
    entry('string-width.5.1.2'),
    entry('string-width-cjs', {
      reason: 'direct',
      installName: 'string-width-cjs',
    }),
  );

  it('round-trips, aliases and install names included', () => {
    const text = serializeLockfile(aliased);
    expect(parseLockfile(text)).toEqual(aliased);
    expect(serializeLockfile(parseLockfile(text))).toBe(text);
    expect(JSON.parse(text).packages.cliui.aliases).toEqual({
      'string-width-cjs': 'string-width.4.2.3',
    });
  });

  it.each([
    ['an array', ['x']],
    ['an empty object', {}],
    ['a non-string target', { a: 1 }],
    ['an empty target', { a: '' }],
    ['an empty name', { '': 'x' }],
  ])('refuses aliases that are %s', (_what, aliases) => {
    const text = JSON.parse(serializeLockfile(lockOf(entry('app')))) as {
      packages: { app: Record<string, unknown> };
    };
    text.packages.app.aliases = aliases;
    expect(() => parseLockfile(JSON.stringify(text))).toThrow(/aliases|alias/u);
  });

  it('refuses an empty install name', () => {
    const text = JSON.parse(serializeLockfile(lockOf(entry('app')))) as {
      packages: { app: Record<string, unknown> };
    };
    text.packages.app.installName = '';
    expect(() => parseLockfile(JSON.stringify(text))).toThrow(/installName/u);
  });

  it('keeps the fields in the order the file wrote them', () => {
    // Locks written before aliases existed kept `dependencies` after the supply
    // chain fields; reading one and writing it must not move anything.
    const parsed = JSON.parse(serializeLockfile(aliased)) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const { aliases, dependencies, ...rest } = parsed.packages.cliui!;
    parsed.packages.cliui = { aliases, ...rest, dependencies };
    const reordered = `${JSON.stringify(parsed, null, 2)}\n`;
    expect(reordered).not.toBe(serializeLockfile(aliased));
    expect(serializeLockfile(parseLockfile(reordered))).toBe(reordered);
  });

  it('reads both kinds of edge as one set of requirements', () => {
    const cliui = aliased.packages.cliui!;
    expect(lockEdges(cliui)).toEqual([
      { key: 'string-width.5.1.2' },
      { key: 'string-width.4.2.3', installName: 'string-width-cjs' },
    ]);
    expect(lockEdgeKeys(cliui)).toEqual([
      'string-width.5.1.2',
      'string-width.4.2.3',
    ]);
    expect([...reachableKeys(aliased.packages, ['cliui'])].sort()).toEqual([
      'cliui',
      'string-width.4.2.3',
      'string-width.5.1.2',
    ]);
  });
});

/** The parts of a selected package a key is made from. */
function instance(exact: string): PackageInstance {
  const at = exact.lastIndexOf('@');
  const version = exact.slice(at + 1);
  const base = exact.slice(0, at);
  // SAFETY: only the identity and version fields that keys read are filled.
  return {
    nodeId: `node-${exact}`,
    nativeVersion: version,
    identity: { canonicalPurl: base, exactPurl: exact, purlType: 'npm' },
  } as unknown as PackageInstance;
}

describe('lock keys', () => {
  const keys = (
    purls: string[],
    directKeys: [string, string][] = [],
  ): Record<string, string> => {
    const selected = purls.map(instance);
    const allocated = allocateLockKeys({
      selected,
      directKeys: new Map(directKeys),
    });
    return Object.fromEntries(
      selected.map((item) => [
        item.identity.exactPurl,
        allocated.get(item.nodeId),
      ]),
    );
  };

  it('keeps the key a name always had when it is selected once', () => {
    expect(keys(['pkg:npm/left@1.0.0', 'pkg:npm/%40scope/util@2.0.0'])).toEqual(
      {
        'pkg:npm/left@1.0.0': 'left',
        'pkg:npm/%40scope/util@2.0.0': '-40scope-util',
      },
    );
    expect(flatLockName('pkg:npm/%40scope/util@2.0.0')).toBe('-40scope-util');
  });

  it('gives each version of a name selected twice its own key, in version order', () => {
    expect(keys(['pkg:npm/shared@10.0.0', 'pkg:npm/shared@2.0.0'])).toEqual({
      'pkg:npm/shared@10.0.0': 'shared.10.0.0',
      'pkg:npm/shared@2.0.0': 'shared.2.0.0',
    });
  });

  it('leaves a direct entry its manifest alias and numbers the other versions', () => {
    expect(
      keys(
        ['pkg:npm/shared@2.0.0', 'pkg:npm/shared@1.4.0'],
        [['pkg:npm/shared@2.0.0', 'shared']],
      ),
    ).toEqual({
      'pkg:npm/shared@2.0.0': 'shared',
      'pkg:npm/shared@1.4.0': 'shared.1.4.0',
    });
  });

  it('avoids a key a direct entry already holds', () => {
    // A direct alias `left` for some other package must not be taken over.
    expect(
      keys(['pkg:npm/left@1.0.0'], [['pkg:npm/other@1.0.0', 'left']]),
    ).toEqual({
      'pkg:npm/left@1.0.0': 'left.2',
    });
  });

  it('writes a prerelease or build version as a safe segment', () => {
    expect(keys(['pkg:npm/p@1.0.0-rc.1+build.5', 'pkg:npm/p@1.0.0'])).toEqual({
      'pkg:npm/p@1.0.0-rc.1+build.5': 'p.1.0.0-rc.1-build.5',
      'pkg:npm/p@1.0.0': 'p.1.0.0',
    });
  });

  it('allocates the same keys whatever order the selection comes in', () => {
    const purls = [
      'pkg:npm/a@1.0.0',
      'pkg:npm/a@2.0.0',
      'pkg:npm/b@1.0.0',
      'pkg:npm/a-b@1.0.0',
    ];
    expect(keys(purls)).toEqual(keys([...purls].reverse()));
  });
});
