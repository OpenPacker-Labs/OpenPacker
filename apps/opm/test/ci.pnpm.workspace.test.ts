import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
 * A pnpm workspace: the project needs `a` (and an optional package per cpu),
 * `packages/web` needs `left` and links `packages/lib`, which needs `right`.
 */
async function workspace(root: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-ws-'));
  temps.push(dir);
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-ws-store-'));
  temps.push(store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const urls: string[] = [];
  const integrity: Record<string, string> = {};
  for (const name of ['a', 'left', 'right', 'plat-x64', 'plat-arm64']) {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({ name, version: '1.0.0' }),
        ),
      },
    ]);
    archives.set(`${ORIGIN}/${name}/-/${name}-1.0.0.tgz`, bytes);
    integrity[name] =
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  }
  const write = async (path: string, text: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  await write(
    'package.json',
    JSON.stringify({
      name: 'app',
      dependencies: { a: '^1.0.0' },
      optionalDependencies: { 'plat-x64': '^1.0.0', 'plat-arm64': '^1.0.0' },
      ...root,
    }),
  );
  await write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  await write(
    'packages/web/package.json',
    JSON.stringify({
      name: 'web',
      dependencies: { left: '^1.0.0', lib: 'workspace:*' },
    }),
  );
  await write(
    'packages/lib/package.json',
    JSON.stringify({ name: 'lib', dependencies: { right: '^1.0.0' } }),
  );
  const entry = (name: string, extra = '') =>
    `  ${name}@1.0.0:\n    resolution: {integrity: ${integrity[name]}}\n${extra}\n`;
  const direct = (name: string, specifier: string, version = '1.0.0') =>
    `      ${name}:\n        specifier: ${specifier}\n        version: ${version}\n`;
  await write(
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
${direct('a', '^1.0.0')}    optionalDependencies:
${direct('plat-arm64', '^1.0.0')}${direct('plat-x64', '^1.0.0')}
  packages/lib:
    dependencies:
${direct('right', '^1.0.0')}
  packages/web:
    dependencies:
${direct('left', '^1.0.0')}${direct('lib', 'workspace:*', 'link:../lib')}
packages:

${entry('a')}${entry('left')}${entry('plat-arm64', '    cpu: [arm64]\n')}${entry('plat-x64', '    cpu: [x64]\n')}${entry('right')}snapshots:

  a@1.0.0: {}
  left@1.0.0: {}
  plat-arm64@1.0.0:
    optional: true
  plat-x64@1.0.0:
    optional: true
  right@1.0.0: {}
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

const list = async (dir: string, path: string) =>
  (await readdir(join(dir, path))).filter((n) => !n.startsWith('.')).sort();

const run = async (
  p: Awaited<ReturnType<typeof workspace>>,
  ...args: string[]
) => {
  const c = capture();
  const code = await runOpm(['ci', '--path', p.dir, ...args], c.io, '/', {
    fetch: p.fetcher,
  });
  return { code, out: c.out, err: c.err };
};

describe('opm ci --plan', () => {
  it('says what the install would do, and fetches and writes nothing', async () => {
    const p = await workspace();
    const result = await run(p, '--plan');
    expect(result.code).toBe(EXIT_CODES.success);
    expect(result.err).toBe('');
    expect(result.out).toMatch(
      /^Plan for .*\(.*pnpm-lock\.yaml\): nothing was fetched or written\n {2}\d+ packages? in \d+ places? under node_modules, from \d+ archives?\n/u,
    );
    // The plan is the same text every time, so two plans can be diffed.
    expect((await run(p, '--plan')).out).toBe(result.out);
    expect(result.out).toContain(
      '  left out: 1 optional, for another platform\n',
    );
    expect(result.out).toContain(
      '  workspace: 2 of 2 members installed, 1 linked at the project\n',
    );
    expect(p.urls).toEqual([]);
    await expect(stat(join(p.dir, 'node_modules'))).rejects.toThrow();
  });

  it('refuses what the install would', async () => {
    const p = await workspace();
    await writeFile(join(p.dir, 'package.json'), '{"name":"app"}');
    const result = await run(p, '--plan');
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.err).toMatch(/not up to date with the project/u);
  });
});

describe('opm ci --filter', () => {
  it("installs the member, the member it links and what they need, in pnpm's grammar", async () => {
    const p = await workspace();
    const result = await run(p, '--filter', 'web');
    expect(result.err).toBe('');
    expect(result.code).toBe(EXIT_CODES.success);
    expect(await list(p.dir, 'packages/web/node_modules')).toEqual(['left']);
    expect(await list(p.dir, 'packages/lib/node_modules')).toEqual(['right']);
    expect(await list(p.dir, 'node_modules')).toEqual(['lib']);
    expect(result.out).toContain(
      '  workspace: 1 of 2 members linked, not fetched',
    );
  });

  it('takes -F, and a repeated selector', async () => {
    const p = await workspace();
    expect((await run(p, '-F', 'lib', '-F', '!web')).code).toBe(
      EXIT_CODES.success,
    );
    expect(await list(p.dir, 'packages/lib/node_modules')).toEqual(['right']);
  });

  it('needs a selector, refuses one that matches nothing, and refuses it with -w', async () => {
    const p = await workspace();
    const none = await run(p, '--filter');
    expect(none.code).toBe(EXIT_CODES.invalidInput);
    expect(none.err).toMatch(/opm ci --filter needs a selector/u);
    const missing = await run(p, '--filter', 'nope');
    expect(missing.code).toBe(EXIT_CODES.invalidInput);
    const both = await run(p, '--filter', 'web', '-w', 'web');
    expect(both.code).toBe(EXIT_CODES.invalidInput);
    expect(both.err).toMatch(/pnpm's grammar and --workspace by npm's/u);
    expect(p.urls).toEqual([]);
  });
});

describe('opm ci --os --cpu --libc --supported-architectures', () => {
  it('installs the optional package of every platform it is told', async () => {
    const p = await workspace();
    const result = await run(
      p,
      '--os',
      'linux',
      '--cpu',
      'x64',
      '--cpu',
      'arm64',
    );
    expect(result.code).toBe(EXIT_CODES.success);
    expect(await list(p.dir, 'node_modules')).toEqual(
      expect.arrayContaining(['plat-arm64', 'plat-x64']),
    );
    expect(result.out).toContain(
      '  platforms: linux/x64/glibc, linux/arm64/glibc\n',
    );
  });

  it("takes the project's own setting only when asked", async () => {
    const root = {
      pnpm: { supportedArchitectures: { cpu: ['arm64', 'x64'] } },
    };
    const plain = await workspace(root);
    await run(plain);
    expect(await list(plain.dir, 'node_modules')).not.toContain('plat-arm64');
    const asked = await workspace(root);
    const result = await run(asked, '--supported-architectures', 'project');
    expect(result.code).toBe(EXIT_CODES.success);
    expect(await list(asked.dir, 'node_modules')).toContain('plat-arm64');
  });

  it.each([
    [['--supported-architectures', 'both'], /takes "project", not "both"/u],
    [
      ['--supported-architectures', 'project', '--cpu', 'x64'],
      /either --supported-architectures project or --os, --cpu and --libc/u,
    ],
    [['--os', 'lin ux'], /--os "lin ux" is not a platform name/u],
    [['--cpu'], /--cpu needs a value/u],
  ])('refuses %j', async (args, message) => {
    const p = await workspace();
    const result = await run(p, ...args);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.err).toMatch(message);
    expect(p.urls).toEqual([]);
  });
});

describe('opm ci --help', () => {
  it('lists the options of a pnpm install and says which lock it reads', async () => {
    const c = capture();
    expect(await runOpm(['ci', '--help'], c.io, '/')).toBe(EXIT_CODES.success);
    for (const word of [
      'pnpm-lock.yaml',
      '--filter|-F <selector>',
      '--os <os>',
      '--cpu <cpu>',
      '--libc <libc>',
      '--supported-architectures project',
      '--plan',
      'packageManager',
    ])
      expect(c.out).toContain(word);
  });
});
