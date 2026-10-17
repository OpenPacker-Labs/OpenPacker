import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * A project with a `pnpm-lock.yaml` of three packages (one dev, one with an
 * install script) and a fetch that serves them. A pnpm lock records no URL and
 * no install-script flag: the URL is the registry's standard path and the
 * script is found in the archive.
 */
async function project(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-'));
  temps.push(dir);
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-store-'));
  temps.push(store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const urls: string[] = [];
  const integrity: Record<string, string> = {};
  const add = (
    name: string,
    version: string,
    scripts?: Record<string, string>,
  ) => {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({
            name,
            version,
            bin: { [name]: 'cli.js' },
            ...(scripts && { scripts }),
          }),
        ),
      },
      {
        path: 'package/cli.js',
        contents: new TextEncoder().encode(
          `console.log(${JSON.stringify(name)});\n`,
        ),
      },
    ]);
    archives.set(`${ORIGIN}/${name}/-/${name}-${version}.tgz`, bytes);
    integrity[name] =
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  };
  add('runtime', '1.0.0');
  add('test-tool', '2.0.0');
  add('builds', '3.0.0', { postinstall: 'node build.js' });
  const manifest = {
    name: 'app',
    version: '1.0.0',
    dependencies: { runtime: '1.0.0', builds: '3.0.0' },
    devDependencies: { 'test-tool': '2.0.0' },
    ...extra,
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  const dependency = (name: string, specifier: string, version: string) =>
    `      ${name}:\n        specifier: ${specifier}\n        version: ${version}\n`;
  const entry = (name: string, version: string) =>
    `  ${name}@${version}:\n    resolution: {integrity: ${integrity[name]}}\n    hasBin: true\n\n`;
  await writeFile(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
${dependency('builds', '3.0.0', '3.0.0')}${dependency('runtime', '1.0.0', '1.0.0')}    devDependencies:
${dependency('test-tool', '2.0.0', '2.0.0')}
packages:

${entry('builds', '3.0.0')}${entry('runtime', '1.0.0')}${entry('test-tool', '2.0.0')}snapshots:

  builds@3.0.0: {}
  runtime@1.0.0: {}
  test-tool@2.0.0: {}
`,
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

describe('opm ci with a pnpm-lock.yaml', () => {
  it('installs the lock, and counts the install scripts it found in the archives and did not run', async () => {
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
    // The lock records no URL: the registry's standard path was fetched.
    expect(p.urls.sort()).toEqual([
      `${ORIGIN}/builds/-/builds-3.0.0.tgz`,
      `${ORIGIN}/runtime/-/runtime-1.0.0.tgz`,
      `${ORIGIN}/test-tool/-/test-tool-2.0.0.tgz`,
    ]);
  });

  it('leaves out development dependencies with --production', async () => {
    const p = await project();
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir, '--production'], c.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual(['builds', 'runtime']);
    expect(c.out).toContain('  left out: 1 left out by --omit\n');
  });

  it('refuses --omit peer, which a pnpm lock has nothing to omit by', async () => {
    const p = await project();
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir, '--omit', 'peer'], c.io, '/', {
        fetch: p.fetcher,
      }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.err).toMatch(/--omit peer does not apply to a pnpm lock/u);
    await expect(stat(join(p.dir, 'node_modules'))).rejects.toThrow();
  });
});

describe('what opm ci writes to the terminal', () => {
  it('escapes a control sequence a package.json that is not JSON echoes, wherever the message comes from', async () => {
    const p = await project();
    // V8's JSON.parse quotes the bad text in its message: an OSC that sets the
    // terminal's title, a CSI, and a right-to-left override.
    await writeFile(
      join(p.dir, 'package.json'),
      '\u202e\u001b]0;PWN\u0007\u009b2J',
    );
    const c = capture();
    const code = await runOpm(['ci', '--plan', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(code).not.toBe(EXIT_CODES.success);
    expect(c.err).toContain('\\u001b]0;PWN\\u0007');
    const raw = [...c.err].filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code < 0x20 && code !== 0x0a) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e)
      );
    });
    expect(raw).toEqual([]);
    expect(c.err.endsWith('\n')).toBe(true);
    expect(p.urls).toEqual([]);
  });
});

describe('opm ci in a project with both locks', () => {
  const both = async (packageManager?: string) => {
    const p = await project(
      packageManager === undefined ? {} : { packageManager },
    );
    await writeFile(
      join(p.dir, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: { '': {} },
      }),
    );
    return p;
  };

  it('refuses, naming both files, when nothing says which tool installs it', async () => {
    const p = await both();
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.err).toMatch(
      /has both package-lock\.json and pnpm-lock\.yaml, and its package\.json has no packageManager field/u,
    );
    expect(p.urls).toEqual([]);
    await expect(stat(join(p.dir, 'node_modules'))).rejects.toThrow();
  });

  it('refuses when packageManager names a manager with another lock', async () => {
    const p = await both('yarn@4.1.0');
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.err).toMatch(/names yarn as its packageManager/u);
  });

  it('takes the pnpm lock when packageManager is pnpm', async () => {
    const p = await both('pnpm@10.28.0+sha512.abc');
    const c = capture();
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual(['builds', 'runtime', 'test-tool']);
  });

  it('takes the npm lock when packageManager is npm', async () => {
    const p = await both('npm@10.9.4');
    const c = capture();
    // The npm lock above is empty, and the manifest no longer matches it.
    expect(
      await runOpm(['ci', '--path', p.dir], c.io, '/', { fetch: p.fetcher }),
    ).toBe(EXIT_CODES.invalidInput);
    expect(c.err).toMatch(/package-lock\.json are not in sync/u);
  });
});
