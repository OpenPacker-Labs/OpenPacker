import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { EXIT_CODES, runOpm } from '../src/opm.js';

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

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

const ORIGIN = 'https://registry.npmjs.org';

/** A project with a lock of three packages and a fetch that serves them. */
async function project(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-'));
  temps.push(dir);
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-store-'));
  temps.push(store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const urls: string[] = [];
  const packages: Record<string, unknown> = {};
  const add = (
    name: string,
    version: string,
    entry: Record<string, unknown>,
  ) => {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({ name, version, bin: { [name]: 'cli.js' } }),
        ),
      },
      {
        path: 'package/cli.js',
        contents: new TextEncoder().encode(
          `console.log(${JSON.stringify(name)});\n`,
        ),
      },
    ]);
    const url = `${ORIGIN}/${name}/-/${name}-${version}.tgz`;
    archives.set(url, bytes);
    packages[`node_modules/${name}`] = {
      version,
      resolved: url,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      ...entry,
    };
  };
  add('runtime', '1.0.0', {});
  add('test-tool', '2.0.0', { dev: true });
  add('builds', '3.0.0', { hasInstallScript: true });
  const manifest = {
    name: 'app',
    version: '1.0.0',
    dependencies: { runtime: '1.0.0', builds: '3.0.0' },
    devDependencies: { 'test-tool': '2.0.0' },
    ...extra,
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': manifest, ...packages },
    }),
  );
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    const body = archives.get(url);
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(body);
  }) as typeof fetch;
  return { dir, urls, fetcher };
}

const names = async (dir: string) =>
  (await readdir(join(dir, 'node_modules')))
    .filter((n) => !n.startsWith('.'))
    .sort();

describe('opm ci', () => {
  it('installs the lock, says what it did, and counts the install scripts it did not run', async () => {
    const p = await project();
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(c.err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual(['builds', 'runtime', 'test-tool']);
    expect(c.out).toMatch(
      /^Installed 3 packages into .*node_modules \(0 from the store, 3 fetched, 0\.0 MB\) in \d+\.\d s; 1 declares an install script, which opm does not run\n/u,
    );
    expect(c.out).toContain('  install script not run: builds@3.0.0\n');
    expect(
      (await stat(join(p.dir, 'node_modules/.bin/runtime'))).mode & 0o111,
    ).not.toBe(0);
  });

  it('leaves out dev packages with --production and says how many', async () => {
    const p = await project();
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir, '--production'], c.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual(['builds', 'runtime']);
    expect(c.out).toContain('Installed 2 packages');
    expect(c.out).toContain('  left out: 1 left out by --omit\n');
    expect(p.urls.some((url) => url.includes('test-tool'))).toBe(false);
  });

  it('takes --omit, and refuses a kind it does not know', async () => {
    const p = await project();
    const ok = capture();
    await runOpm(['ci', '--path', p.dir, '--omit', 'dev'], ok.io, '/', {
      fetch: p.fetcher,
    });
    expect(await names(p.dir)).toEqual(['builds', 'runtime']);
    const bad = capture();
    expect(
      await runOpm(['ci', '--path', p.dir, '--omit', 'bogus'], bad.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(bad.err).toMatch(/cannot omit "bogus"/u);
  });

  it('is the same as opm install --frozen, in the current directory', async () => {
    const p = await project();
    const c = capture();
    expect(
      await runOpm(['install', '--frozen'], c.io, p.dir, { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual(['builds', 'runtime', 'test-tool']);
  });

  it('works offline from the store once it has the packages', async () => {
    const p = await project();
    await runOpm(['ci', '--path', p.dir], capture().io, '/', {
      fetch: p.fetcher,
    });
    const before = p.urls.length;
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir, '--offline'], c.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.success);
    expect(p.urls).toHaveLength(before);
    expect(c.out).toContain('(3 from the store, 0 fetched, 0.0 MB)');
  });

  it('fails with the right exit code when the bytes are not the ones pinned', async () => {
    const p = await project();
    const tampered: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]));
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: tampered }),
    ).toBe(EXIT_CODES.verificationFailed);
    expect(c.err).toMatch(/does not match the integrity the lock pins/u);
    await expect(stat(join(p.dir, 'node_modules'))).rejects.toThrow();
  });

  it('refuses a workspace lock with the invalid-input exit code and the member list', async () => {
    const p = await project({ workspaces: ['packages/*'] });
    const lockPath = join(p.dir, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.packages['node_modules/member'] = {
      resolved: 'packages/member',
      link: true,
    };
    lock.packages['packages/member'] = { name: 'member', version: '1.0.0' };
    await writeFile(lockPath, JSON.stringify(lock));
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.err).toMatch(/packages\/member: a workspace member \(member\)/u);
    expect(p.urls).toEqual([]);
  });

  it('says what to do when there is no lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-ci-empty-'));
    temps.push(dir);
    const c = capture();
    expect(await runOpm(['ci', '--path', dir], c.io, '/')).toBe(
      EXIT_CODES.notFound,
    );
    expect(c.err).toMatch(/package-lock\.json/u);
  });

  it('is listed in the help', async () => {
    const c = capture();
    await runOpm(['help'], c.io, '/');
    expect(c.out).toMatch(/opm ci \[--path <dir>\] \[--production\]/u);
  });
});
