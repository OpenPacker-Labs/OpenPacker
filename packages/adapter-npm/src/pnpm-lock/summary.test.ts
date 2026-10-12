import { describe, expect, it } from 'vitest';
import { exoticSourcesOf } from './exotic.js';
import { withBlocksReversed } from './fixture-support.js';
import { parsePnpmLock } from './parse.js';
import { BASE, SHA512, edit } from './read-support.test-helpers.js';
import { summarizePnpmLock } from './summary.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Packages b, c@1, c@2 (restricted), d (an alias target) and e (links), all reachable from the root importer. */
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0
      alias:
        specifier: npm:d@^1
        version: d@1.0.0
      lib:
        specifier: workspace:*
        version: link:packages/lib
    devDependencies:
      c:
        specifier: ^2.0.0
        version: 2.0.0

  packages/lib: {}

packages:

  a@1.0.0:
    resolution: {integrity: ${SHA512}}

  c@1.0.0:
    resolution: {integrity: ${SHA512}}
    os: [darwin]

  c@2.0.0:
    resolution: {integrity: ${SHA512}}
    cpu: [x64]
    libc: [musl]

  d@1.0.0:
    resolution: {integrity: ${SHA512}}
    os: []

  t@https://h/t.tgz:
    resolution: {tarball: "https://h/t.tgz"}
    version: 1.0.0

  g@git+https://h/g.git#${SHA}:
    resolution: {commit: ${SHA}, repo: "https://h/g.git", type: git, path: sub}
    version: 1.0.0

  f@file:../f:
    resolution: {directory: ../f, type: directory}
    version: 1.0.0

snapshots:

  a@1.0.0:
    dependencies:
      c: 1.0.0
      t: https://h/t.tgz
    optionalDependencies:
      other: d@1.0.0
      g: git+https://h/g.git#${SHA}&path:sub
      f: file:../f
      l: link:../l

  c@1.0.0: {}

  c@2.0.0: {}

  d@1.0.0: {}

  t@https://h/t.tgz: {}

  g@git+https://h/g.git#${SHA}&path:sub: {}

  f@file:../f: {}
`;

describe('summarizePnpmLock', () => {
  const lock = parsePnpmLock(LOCK);
  const summary = summarizePnpmLock(lock);

  it('counts importers, packages and snapshots', () => {
    expect(summary).toMatchObject({
      lockfileVersion: '9.0',
      importers: 2,
      packages: 7,
      snapshots: 7,
    });
  });

  it('counts the edges each side lists, and which are links and aliases', () => {
    expect(summary.dependencyEdges).toEqual({ importers: 4, snapshots: 6 });
    expect(summary.linkEdges).toEqual({ importers: 1, snapshots: 1 });
    expect(summary.aliasEdges).toEqual({ importers: 1, snapshots: 1 });
  });

  it('counts exotic sources by kind', () => {
    expect(summary.exoticSources).toEqual({
      tarball: 1,
      git: 1,
      directory: 1,
      runtime: 0,
    });
  });

  it('lists names held in several versions, versions in order', () => {
    expect(summary.multiVersionNames).toEqual([
      { name: 'c', versions: ['1.0.0', '2.0.0'] },
    ]);
  });

  it('lists packages that restrict os, cpu or libc, and not the one whose list is empty', () => {
    expect(summary.platformRestricted).toEqual([
      { key: 'c@1.0.0', os: ['darwin'] },
      { key: 'c@2.0.0', cpu: ['x64'], libc: ['musl'] },
    ]);
  });

  it('is the same value however the file orders its entries', () => {
    const reversed = withBlocksReversed(LOCK);
    expect(reversed).not.toBe(LOCK);
    expect(summarizePnpmLock(parsePnpmLock(reversed))).toEqual(summary);
  });

  it('has nothing to say about a lock with nothing in it', () => {
    expect(summarizePnpmLock(parsePnpmLock(BASE))).toEqual({
      lockfileVersion: '9.0',
      importers: 1,
      packages: 1,
      snapshots: 1,
      dependencyEdges: { importers: 1, snapshots: 0 },
      linkEdges: { importers: 0, snapshots: 0 },
      aliasEdges: { importers: 0, snapshots: 0 },
      exoticSources: { tarball: 0, git: 0, directory: 0, runtime: 0 },
      multiVersionNames: [],
      platformRestricted: [],
    });
  });
});

describe('exoticSourcesOf', () => {
  it('says what each exotic package points at, in key order', () => {
    expect(exoticSourcesOf(parsePnpmLock(LOCK))).toEqual([
      {
        kind: 'directory',
        key: 'f@file:../f',
        name: 'f',
        version: 'file:../f',
        directory: '../f',
      },
      {
        kind: 'git',
        key: `g@git+https://h/g.git#${SHA}`,
        name: 'g',
        version: `git+https://h/g.git#${SHA}`,
        repo: 'https://h/g.git',
        commit: SHA,
        path: 'sub',
      },
      {
        kind: 'tarball',
        key: 't@https://h/t.tgz',
        name: 't',
        version: 'https://h/t.tgz',
        url: 'https://h/t.tgz',
      },
    ]);
  });

  it('carries the integrity a tarball resolution has, and says nothing of registry packages', () => {
    const text = edit(
      BASE,
      `{integrity: ${SHA512}}`,
      `{integrity: ${SHA512}, tarball: "https://registry.example/a-1.0.0.tgz"}`,
    );
    expect(exoticSourcesOf(parsePnpmLock(text))).toEqual([
      {
        kind: 'tarball',
        key: 'a@1.0.0',
        name: 'a',
        version: '1.0.0',
        url: 'https://registry.example/a-1.0.0.tgz',
        integrity: SHA512,
      },
    ]);
    expect(exoticSourcesOf(parsePnpmLock(BASE))).toEqual([]);
  });
});
