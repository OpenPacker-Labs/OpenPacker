import { describe, expect, it } from 'vitest';
import { parsePnpmLock } from './parse.js';
import { BASE, SHA512 } from './read-support.test-helpers.js';

const FULL = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: true
  peersSuffixMaxLength: 400
  injectWorkspacePackages: true

catalogs:
  default:
    b:
      specifier: ^2.0.0
      version: 2.0.0
  alt:
    b:
      specifier: ^1.0.0
      version: 1.0.0

overrides:
  zz: 1.0.0
  aa>bb: link:../bb

packageExtensionsChecksum: sha256-AbC+/=
pnpmfileChecksum: abc123

ignoredOptionalDependencies:
  - fsevents
  - '@scope/optional'

patchedDependencies:
  a@1.0.0:
    hash: abcdefghijklmnopqrstuvwxyz
    path: patches/a@1.0.0.patch

time:
  a@1.0.0: '2024-01-01T00:00:00.000Z'

importers:

  packages/lib:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b
    devDependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0(patch_hash=abcdefghijklmnopqrstuvwxyz)
    optionalDependencies:
      b:
        specifier: ^2.0.0
        version: 2.0.0
    dependenciesMeta:
      b:
        injected: true
        node: 22.0.0
        patch: patches/b.patch
    publishDirectory: dist

  .: {}

packages:

  b@2.0.0:
    resolution: {integrity: ${SHA512}}
    engines: {node: '>=18', npm: '>=9'}
    cpu: [x64]
    os: [linux, '!win32']
    libc: [glibc]
    hasBin: true
    deprecated: gone
    peerDependencies:
      a: ^1.0.0
    peerDependenciesMeta:
      a:
        optional: true
    bundledDependencies:
      - c
    name: b
    version: 2.0.0

  a@1.0.0:
    resolution: {integrity: ${SHA512}}

snapshots:

  b@2.0.0:
    dependencies:
      a: 1.0.0(patch_hash=abcdefghijklmnopqrstuvwxyz)
    optionalDependencies:
      c: link:../c
    transitivePeerDependencies:
      - supports-color
    optional: true
    id: b-id
    patched: false

  a@1.0.0(patch_hash=abcdefghijklmnopqrstuvwxyz): {}
`;

describe('parsePnpmLock: every section', () => {
  const lock = parsePnpmLock(FULL);

  it('reads the settings and the checksums', () => {
    expect(lock.lockfileVersion).toBe('9.0');
    expect(lock.settings).toEqual({
      autoInstallPeers: false,
      excludeLinksFromLockfile: true,
      peersSuffixMaxLength: 400,
      injectWorkspacePackages: true,
    });
    expect(lock.packageExtensionsChecksum).toBe('sha256-AbC+/=');
    expect(lock.pnpmfileChecksum).toBe('abc123');
    expect(lock.ignoredOptionalDependencies).toEqual([
      'fsevents',
      '@scope/optional',
    ]);
    expect(lock.time).toEqual(
      new Map([['a@1.0.0', '2024-01-01T00:00:00.000Z']]),
    );
  });

  it('reads overrides, catalogs and patches, each in key order', () => {
    expect([...lock.overrides]).toEqual([
      ['aa>bb', 'link:../bb'],
      ['zz', '1.0.0'],
    ]);
    expect([...lock.catalogs.keys()]).toEqual(['alt', 'default']);
    expect(lock.catalogs.get('default')?.get('b')).toMatchObject({
      specifier: '^2.0.0',
      ref: { kind: 'dep', aliased: false },
    });
    expect(lock.patchedDependencies.get('a@1.0.0')).toEqual({
      hash: 'abcdefghijklmnopqrstuvwxyz',
      path: 'patches/a@1.0.0.patch',
    });
  });

  it('reads an importer in id order, its three lists, its meta and its publish directory', () => {
    expect(lock.importers.map((importer) => importer.id)).toEqual([
      '.',
      'packages/lib',
    ]);
    const lib = lock.importers[1]!;
    expect(
      lib.dependencies.map((d) => [d.name, d.specifier, d.ref.kind]),
    ).toEqual([['b', 'workspace:*', 'link']]);
    expect(lib.devDependencies[0]?.ref).toMatchObject({
      kind: 'dep',
      target: { patchHash: 'abcdefghijklmnopqrstuvwxyz' },
    });
    expect(lib.optionalDependencies).toHaveLength(1);
    expect(lib.dependenciesMeta.get('b')).toEqual({
      injected: true,
      node: '22.0.0',
      patch: 'patches/b.patch',
    });
    expect(lib.publishDirectory).toBe('dist');
    expect(lock.importers[0]).toMatchObject({ id: '.', dependencies: [] });
  });

  it('reads every field of a package', () => {
    const b = lock.packages.find((p) => p.key === 'b@2.0.0')!;
    expect(b).toMatchObject({
      name: 'b',
      version: '2.0.0',
      source: 'registry',
      resolution: { kind: 'integrity', integrity: SHA512 },
      manifestName: 'b',
      manifestVersion: '2.0.0',
      cpu: ['x64'],
      os: ['linux', '!win32'],
      libc: ['glibc'],
      hasBin: true,
      deprecated: 'gone',
      bundledDependencies: ['c'],
    });
    expect([...b.engines]).toEqual([
      ['node', '>=18'],
      ['npm', '>=9'],
    ]);
    expect([...b.peerDependencies]).toEqual([['a', '^1.0.0']]);
    expect(b.peerDependenciesMeta.get('a')).toEqual({ optional: true });
    const a = lock.packages.find((p) => p.key === 'a@1.0.0')!;
    expect(a).toMatchObject({
      hasBin: false,
      engines: new Map(),
      peerDependencies: new Map(),
    });
    expect(a.cpu).toBeUndefined();
    expect(a.bundledDependencies).toBeUndefined();
  });

  it('reads every field of a snapshot', () => {
    const b = lock.snapshots.find((s) => s.key === 'b@2.0.0')!;
    expect(b).toMatchObject({
      optional: true,
      id: 'b-id',
      patched: false,
      transitivePeerDependencies: ['supports-color'],
    });
    expect(b.dependencies.map((d) => d.name)).toEqual(['a']);
    expect(b.optionalDependencies[0]?.ref.kind).toBe('link');
    expect(
      lock.snapshots.find((s) => s.key.startsWith('a@1.0.0'))?.path.patchHash,
    ).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('reads a lock with no sections but its version', () => {
    expect(parsePnpmLock("lockfileVersion: '9.0'\n")).toMatchObject({
      settings: {},
      importers: [],
      packages: [],
      snapshots: [],
    });
  });

  it('reads bytes as UTF-8, and refuses bytes that are not', () => {
    expect(parsePnpmLock(Buffer.from(BASE)).packages).toHaveLength(1);
    expect(() => parsePnpmLock(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(
      /UTF-8/u,
    );
    const huge = Buffer.alloc(100);
    expect(() => parsePnpmLock(huge, { maxBytes: 50 })).toThrow(/maxBytes/u);
  });
});
