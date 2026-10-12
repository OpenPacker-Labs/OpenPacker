import { expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * A cloned repository's files, with text in one field that starts lines of its
 * own: what a person runs `opm ci`, `opm install` or `opm list` against after
 * a `git clone`. The same repository is run with innocent text in that field
 * (`x`) and with the payload, and the two outputs are compared line for line.
 */

const ESC = '\u001b';

/** A line feed, a line that looks like opm's, a list entry and an erase. */
export const PAYLOAD = `\nopm: ok installed 1 package@1\n  - pkg:npm/b@1: forged\n${ESC}[2K`;

/** A JSON document, as a repository's file holds it. */
export interface Json {
  [key: string]: Json | Json[] | string | number | boolean | null;
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const INTEGRITY = `sha512-${Buffer.from('x'.repeat(64)).toString('base64')}`;

function registryEntry(name: string, extra: Json = {}): Json {
  return {
    version: '1.0.0',
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: INTEGRITY,
    ...extra,
  };
}

/**
 * `package.json` and `package-lock.json` of a project `opm ci` reads. `plain`
 * holds registry packages only, so `opm ci` gets as far as the store; `links`
 * adds a link, a workspace member and a git source, which it refuses.
 */
export function npmFiles(
  variant: 'plain' | 'links',
  edit: (lock: Json, manifest: Json) => void,
) {
  const links = variant === 'links';
  const dependencies: Json = {
    a: '^1.0.0',
    ...(links && { lnk: 'file:packages/l' }),
  };
  const manifest: Json = {
    name: 'app',
    version: '1.0.0',
    dependencies: { ...dependencies },
    devDependencies: { d: '1.0.0' },
    peerDependencies: { p: '1.0.0' },
  };
  const root: Json = {
    name: 'app',
    version: '1.0.0',
    dependencies: { ...dependencies },
    devDependencies: { d: '1.0.0' },
    peerDependencies: { p: '1.0.0' },
  };
  const lock: Json = {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': root,
      'node_modules/a': registryEntry('a', {
        os: ['linux'],
        cpu: ['x64'],
        dependencies: { b: '^1.0.0' },
      }),
      'node_modules/b': registryEntry('b'),
      'node_modules/d': registryEntry('d', { dev: true }),
      'node_modules/p': registryEntry('p', { peer: true }),
      'node_modules/alias': registryEntry('real', { name: 'real' }),
      ...(links && {
        'node_modules/g': {
          version: '1.0.0',
          resolved: `git+https://example.test/g.git#${SHA}`,
          integrity: INTEGRITY,
        },
        'node_modules/lnk': { resolved: 'packages/l', link: true },
        'packages/l': { name: 'lnk', version: '1.0.0' },
      }),
    },
  };
  edit(lock, manifest);
  return {
    'package.json': JSON.stringify(manifest),
    'package-lock.json': JSON.stringify(lock),
  };
}

/** The lock entry for the registry package `a`, as `opm install` writes it. */
function opmLockEntry(): Json {
  return {
    purl: 'pkg:npm/a@1.0.0',
    exactPurl: 'pkg:npm/a@1.0.0',
    version: '1.0.0',
    ecosystem: 'npm',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 10,
    format: 'tar+gzip',
    mediaType: 'application/gzip',
    source: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
    storeKey: `sha256-${'a'.repeat(64)}`,
    bins: [{ name: 'ax', path: 'bin/x.js' }],
    reason: 'direct',
    lifecycleStatus: 'published',
    sourceKind: 'registry',
    trustTier: 'registry',
  };
}

/** `opm.toml` and `opm.lock.json` of a project `opm list`, `install` and `sync` read. */
export function opmFiles(
  edit: (lock: Json, toml: { project: Json; options: Json; a: Json }) => void,
) {
  const lock: Json = {
    schemaVersion: 1,
    generatedBy: 'opm',
    packages: { a: opmLockEntry() },
  };
  const toml = {
    project: { name: 'demo', ecosystems: ['npm'] } as Json,
    options: { offline: true, layout: 'opm' } as Json,
    a: { purl: 'pkg:npm/a', version: '1.0.0' } as Json,
  };
  edit(lock, toml);
  const value = (v: Json[string]) => JSON.stringify(v);
  const section = (name: string, fields: Json) =>
    `[${name}]\n${Object.entries(fields)
      .map(([k, v]) => `${k} = ${value(v)}`)
      .join('\n')}\n`;
  return {
    'opm.lock.json': `${JSON.stringify(lock, null, 2)}\n`,
    'opm.toml': [
      section('project', toml.project),
      section('options', toml.options),
      section('packages.a', toml.a),
    ].join('\n'),
  };
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run `opm <argv>` in a directory holding `files`; the store is a scratch one. */
export async function runIn(
  files: Record<string, string>,
  argv: string[],
): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-repo-'));
  const previous = process.env.OPM_STORE_HOME;
  process.env.OPM_STORE_HOME = join(dir, '.store');
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    const cap = capture();
    const code = await runOpm(argv, cap.io, dir, {});
    return { code, out: cap.out, err: cap.err };
  } finally {
    if (previous === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lines that are the payload's own, or an escape, in what was written. */
export function forgedLines(text: string): string[] {
  return text
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('opm: ok installed 1 package') ||
        line.startsWith('  - pkg:npm/b@1: forged') ||
        line.includes(ESC),
    );
}

/** The number of lines in what was written. */
export function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length;
}

/** Everything hostile text could change about what a run writes. */
export async function expectNoNewLines(
  filesWith: (text: string) => Record<string, string>,
  argv: string[],
): Promise<void> {
  const innocent = await runIn(filesWith('x'), argv);
  const hostile = await runIn(filesWith(PAYLOAD), argv);
  expect(forgedLines(hostile.err)).toEqual([]);
  expect(forgedLines(hostile.out)).toEqual([]);
  expect(lineCount(hostile.err)).toBe(lineCount(innocent.err));
  expect(lineCount(hostile.out)).toBe(lineCount(innocent.out));
}

/** The object at `path` below `doc`. */
export function member(doc: Json, ...path: string[]): Json {
  let at: Json[string] = doc;
  for (const key of path) {
    if (typeof at !== 'object' || at === null || Array.isArray(at))
      throw new Error(`no object at ${path.join('.')}`);
    at = at[key] ?? null;
  }
  if (typeof at !== 'object' || at === null || Array.isArray(at))
    throw new Error(`no object at ${path.join('.')}`);
  return at;
}

/** Rename one key of `doc`, keeping the order of the others. */
export function renameKey(doc: Json, from: string, to: string): void {
  const entries = Object.entries(doc);
  for (const key of Object.keys(doc)) delete doc[key];
  for (const [key, value] of entries) doc[key === from ? to : key] = value;
}
