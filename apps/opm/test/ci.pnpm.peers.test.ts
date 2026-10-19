/**
 * What `opm ci` and `opm ci --plan` say when a pnpm lock's peers cannot all be
 * kept to one copy (ADR 0055 §9): one plain line on stderr naming how many
 * dependencies load their own copy and which first, and nothing otherwise. The
 * install is not refused: pnpm installs the lock, and every dependency still
 * resolves to the instance the lock names.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { EXIT_CODES, runOpm } from '../src/opm.js';
import { peerNotice, printPeerNotice } from '../src/commands/ci-peers.js';
import { capture } from './run-fixture.js';

const ORIGIN = 'https://registry.npmjs.org';
const temps: string[] = [];
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPM_STORE_HOME;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.OPM_STORE_HOME;
  else process.env.OPM_STORE_HOME = previous;
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const text = (value: string) => new TextEncoder().encode(value);

/** The archives of `packages` (`name@version`), by address, and their integrity by `name@version`. */
function archives(packages: readonly string[]) {
  const bytesOf = new Map<string, Uint8Array>();
  const integrity = new Map<string, string>();
  for (const spec of packages) {
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: text(JSON.stringify({ name, version })),
      },
      { path: 'package/index.js', contents: text('module.exports = 1;\n') },
    ]);
    bytesOf.set(`${ORIGIN}/${name}/-/${name}-${version}.tgz`, bytes);
    integrity.set(
      spec,
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    );
  }
  return { bytesOf, integrity };
}

/** A workspace with one member `m2` that needs `needs`, the lock `lock(integrity)` writes, and a fetch that serves the archives. */
async function project(
  packages: readonly string[],
  needs: readonly string[],
  lock: (integrity: ReadonlyMap<string, string>) => string,
) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-peers-'));
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-peers-store-'));
  temps.push(dir, store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const { bytesOf, integrity } = archives(packages);
  await mkdir(join(dir, 'packages/m2'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'root', version: '1.0.0', private: true }),
  );
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n',
  );
  await writeFile(
    join(dir, 'packages/m2/package.json'),
    JSON.stringify({
      name: 'm2',
      version: '1.0.0',
      dependencies: Object.fromEntries(needs.map((name) => [name, '*'])),
    }),
  );
  await writeFile(join(dir, 'pnpm-lock.yaml'), lock(integrity));
  const fetch = (async (input: string | URL | Request) => {
    const body = bytesOf.get(typeof input === 'string' ? input : String(input));
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(body);
  }) as typeof globalThis.fetch;
  return { dir, fetch };
}

const HOST = 'p1@3.0.0(p4@1.0.0(p1@3.0.0))';
const PLUGIN = 'p4@1.0.0(p1@3.0.0)';
const NEEDS_BOTH = 'p2@1.0.0(p1@3.0.0)(p4@1.0.0(p1@3.0.0))';
const afterAt = (key: string) => key.slice(key.indexOf('@') + 1);

/** The review's world: `p1@3` depends on `p1@1`, on `p2@1` and on a plugin `p4` that peers `p1`; `p2@1` peers `p4` and `p1`. */
const KEPT = (integrity: ReadonlyMap<string, string>) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  '.': {}
  packages/m2:
    dependencies:
      p1: {specifier: '*', version: '${afterAt(HOST)}'}
      p2: {specifier: '*', version: '3.0.0'}
      p4: {specifier: '*', version: '${afterAt(PLUGIN)}'}
packages:
  p1@1.0.0: {resolution: {integrity: ${integrity.get('p1@1.0.0')}}}
  p1@3.0.0: {resolution: {integrity: ${integrity.get('p1@3.0.0')}}}
  p2@1.0.0: {resolution: {integrity: ${integrity.get('p2@1.0.0')}}, peerDependencies: {p1: '*', p4: '*'}}
  p2@3.0.0: {resolution: {integrity: ${integrity.get('p2@3.0.0')}}}
  p4@1.0.0: {resolution: {integrity: ${integrity.get('p4@1.0.0')}}, peerDependencies: {p1: '*'}}
snapshots:
  p1@1.0.0: {}
  ${HOST}:
    dependencies:
      p1: 1.0.0
      p2: ${afterAt(NEEDS_BOTH)}
      p4: ${afterAt(PLUGIN)}
  ${PLUGIN}:
    dependencies:
      p1: ${afterAt(HOST)}
  ${NEEDS_BOTH}:
    dependencies:
      p1: ${afterAt(HOST)}
      p4: ${afterAt(PLUGIN)}
  p2@3.0.0: {}
`;

const KEPT_PACKAGES = [
  'p1@1.0.0',
  'p1@3.0.0',
  'p2@1.0.0',
  'p2@3.0.0',
  'p4@1.0.0',
];

const SOLO = (integrity: ReadonlyMap<string, string>) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  '.': {}
  packages/m2:
    dependencies:
      solo: {specifier: '*', version: 1.0.0}
packages:
  solo@1.0.0: {resolution: {integrity: ${integrity.get('solo@1.0.0')}}}
snapshots:
  solo@1.0.0: {}
`;

const NOTICE =
  /^opm: 1 dependency loads another copy of a peer it shares with its dependent \(first: "p\d@\d\.0\.0", needed by "p\d@\d\.0\.0"\); /u;

describe('a lock whose peers no layout can keep to one copy', () => {
  it('is planned, with one line on stderr and the plan on stdout as it is for any lock', async () => {
    const { dir, fetch } = await project(
      KEPT_PACKAGES,
      ['p1', 'p2', 'p4'],
      KEPT,
    );
    const c = capture();
    const code = await runOpm(['ci', '--plan', '--path', dir], c.io, '/', {
      fetch,
    });
    expect(code, c.err).toBe(EXIT_CODES.success);
    expect(c.out.split('\n')).toEqual([
      expect.stringMatching(/^Plan for .*: nothing was fetched or written$/u),
      '  5 packages in 8 places under node_modules, from 5 archives',
      '  workspace: 1 of 1 member installed, 0 linked at the project',
      '',
    ]);
    expect(c.err.trimEnd().split('\n')).toEqual([
      expect.stringMatching(NOTICE),
    ]);
  });

  it('is installed, every package written, with the same one line', async () => {
    const { dir, fetch } = await project(
      KEPT_PACKAGES,
      ['p1', 'p2', 'p4'],
      KEPT,
    );
    const c = capture();
    const code = await runOpm(['ci', '--path', dir], c.io, '/', { fetch });
    expect(code, c.err).toBe(EXIT_CODES.success);
    expect(c.out).toContain('Installed 8 packages');
    expect(c.err.trimEnd().split('\n')).toEqual([
      expect.stringMatching(NOTICE),
    ]);
  });
});

describe('a lock whose peers every layout keeps to one copy', () => {
  it('is planned and installed without a word on stderr', async () => {
    const { dir, fetch } = await project(['solo@1.0.0'], ['solo'], SOLO);
    for (const argv of [['ci', '--plan'], ['ci']]) {
      const c = capture();
      const code = await runOpm([...argv, '--path', dir], c.io, '/', { fetch });
      expect(code, c.err).toBe(EXIT_CODES.success);
      expect(c.err).toBe('');
    }
  });
});

describe('the line about peers', () => {
  const first = { dependency: '"p4@1.0.0"', dependent: '"p2@1.0.0"' };

  it('counts the dependencies and names the first', () => {
    expect(peerNotice({ splits: 3, withoutPeers: false, first })).toBe(
      'opm: 3 dependencies load another copy of a peer they share with their dependent (first: "p4@1.0.0", needed by "p2@1.0.0"); no node_modules layout opm could write gives both one copy, as pnpm\'s symlinks do\n',
    );
  });

  it('says that the places were chosen without peers in view, and what that left', () => {
    expect(peerNotice({ splits: 2, withoutPeers: true, first })).toBe(
      'opm: no layout that keeps each shared peer to one copy could be written, so the places were chosen without peers in view; 2 dependencies load another copy of a peer they share with their dependent (first: "p4@1.0.0", needed by "p2@1.0.0")\n',
    );
    expect(peerNotice({ splits: 0, withoutPeers: true })).toBe(
      'opm: no layout that keeps each shared peer to one copy could be written, so the places were chosen without peers in view; none was found to load another copy of a shared peer\n',
    );
  });

  it('is written as text: nothing in it reaches a terminal as a control', () => {
    const c = capture();
    printPeerNotice(c.io, {
      splits: 1,
      withoutPeers: false,
      first: { dependency: '"a\u001b]0;x\u0007"', dependent: '"b\u202e"' },
    });
    const raw = [...c.err].filter((char) => {
      const code = char.codePointAt(0)!;
      return (
        (code < 0x20 && code !== 0x0a) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        code === 0x202e
      );
    });
    expect(raw).toEqual([]);
    expect(c.err).toContain('\\u001b]0;x\\u0007');
    expect(c.out).toBe('');
  });
});
