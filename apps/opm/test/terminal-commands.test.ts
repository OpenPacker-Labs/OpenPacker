/**
 * What a command prints of a path, a time or a pin it did not make up itself,
 * reached through the command: a project in a directory a repository named, a
 * store, a plugin home and a generation record carrying ESC, BEL, a C1 control
 * and a right-to-left override. Each line must reach the terminal escaped, so
 * that taking the escape out of a command fails here (the review of #179,
 * round 6, N-a). The printers themselves are in `terminal-records.test.ts`;
 * `terminal-sites.test.ts` holds every write in the source to the same rule.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAdapters, recordGeneration } from '@openpacker/opm-project';
import { addPlugin } from '@openpacker/plugin-store';
import { runOpm } from '../src/opm.js';
import { fixturePluginTransport } from './plugin-fixture.js';
import { capture } from './run-fixture.js';
import { unsafeIn } from './terminal-fixture.js';

/** An OSC title (ESC ... BEL), a CSI as its C1 control, and a right-to-left override. */
const HOSTILE = 'v\u001b]0;PWN\u0007\u009b2J\u202ex';
const SHOWN = 'v\\u001b]0;PWN\\u0007\\u009b2J\\u202ex';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');
const PURL = 'pkg:npm/@openpacker/demo-tool@1.1.0';

const temps: string[] = [];
const environment = new Map<string, string | undefined>();
afterEach(async () => {
  for (const [name, value] of environment)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  environment.clear();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function setEnv(name: string, value: string): void {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  process.env[name] = value;
}

/** A directory whose own name is hostile, and the scratch directory above it. */
async function hostileDirectory(
  prefix = HOSTILE,
): Promise<{ outer: string; dir: string }> {
  const outer = await mkdtemp(join(tmpdir(), 'opm-terminal-commands-'));
  temps.push(outer);
  const dir = join(outer, prefix);
  await mkdir(dir);
  return { outer, dir };
}

/** An initialised project in `dir` that can add the demo tool from a catalog it carries. */
async function catalogProject(dir: string): Promise<void> {
  expect(await runOpm(['init', '--name', 'p'], capture().io, dir)).toBe(0);
  const bytes = await readFile(fixtureTgz);
  await mkdir(join(dir, '.opm'), { recursive: true });
  await writeFile(
    join(dir, '.opm/catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        [PURL]: {
          purl: PURL,
          version: '1.1.0',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          size: bytes.byteLength,
          format: 'tar+gzip',
          mediaType: 'application/vnd.npm.package+gzip',
          source: `file:${fixtureTgz}`,
          bins: [{ name: 'demo-tool', path: 'package/bin/demo-tool.js' }],
        },
      },
    }),
  );
}

/** Run `opm argv` in `cwd` and require what it printed to hold the hostile name, escaped, and nothing a terminal acts on. */
async function printed(argv: string[], cwd: string): Promise<string> {
  const c = capture();
  expect(await runOpm(argv, c.io, cwd), c.err).toBe(0);
  const all = c.out + c.err;
  expect(unsafeIn(all)).toEqual([]);
  expect(all).toContain(SHOWN);
  return all;
}

describe('what a command prints of where it works', () => {
  it('opm init: the manifest it wrote', async () => {
    const { dir } = await hostileDirectory();
    const c = capture();
    expect(await runOpm(['init', '--name', 'p'], c.io, dir)).toBe(0);
    expect(unsafeIn(c.out)).toEqual([]);
    expect(c.out).toContain(
      `Initialized opm project at ${dir.replace(HOSTILE, SHOWN)}`,
    );
  });

  it('opm add: the store it installed into', async () => {
    const { dir } = await hostileDirectory();
    await catalogProject(dir);
    expect(await printed(['add', PURL], dir)).toContain('Installed into');
  });

  it('opm install: the directory and the bins it wrote', async () => {
    const { dir } = await hostileDirectory();
    await catalogProject(dir);
    expect(await runOpm(['add', PURL], capture().io, dir)).toBe(0);
    const all = await printed(['install'], dir);
    expect(all).toContain('Installed 1 package(s) into');
    expect(all).toContain('Bins:');
  });

  it('opm gc: the store paths it would remove', async () => {
    const { dir } = await hostileDirectory();
    await catalogProject(dir);
    expect(await runOpm(['add', PURL], capture().io, dir)).toBe(0);
    expect(await runOpm(['remove', 'demo-tool'], capture().io, dir)).toBe(0);
    const all = await printed(['gc', '--dry-run', '--keep', '1'], dir);
    expect(all).toMatch(/Would remove [1-9]\d* store path/u);
  });

  it('opm gc --shared: the shared store it looked in', async () => {
    const { dir, outer } = await hostileDirectory();
    const store = join(outer, `store-${HOSTILE}`);
    await mkdir(store);
    setEnv('OPM_STORE_HOME', store);
    const all = await printed(['gc', '--shared', '--dry-run'], dir);
    expect(all).toContain('unreferenced entries from');
  });
});

describe('what a command prints of what the store or a record says', () => {
  it('opm generations: a time a generation record carries', async () => {
    const { dir } = await hostileDirectory('project');
    expect(await runOpm(['init', '--name', 'p'], capture().io, dir)).toBe(0);
    await recordGeneration({
      root: dir,
      packages: {},
      lockDigest: `sha256:${'0'.repeat(64)}`,
      createdAt: HOSTILE,
    });
    const all = await printed(['generations'], dir);
    expect(all).toContain('0 package(s)');
  });

  it('opm plugin add: the store a plugin is installed in', async () => {
    const { dir } = await hostileDirectory();
    setEnv('OPM_PLUGIN_HOME', dir);
    delete process.env.OPM_REGISTRY_OPM_PLUGIN;
    configureAdapters([]);
    await addPlugin({
      name: 'acme',
      endpoint: 'https://plugins.fixture.test',
      transport: fixturePluginTransport(),
      storeRoot: dir,
      now: () => '2026-08-20T00:00:00.000Z',
    });
    const all = await printed(['plugin', 'add', 'acme'], dir);
    expect(all).toContain('already installed');
    expect(all).toContain('store:');
  });
});
