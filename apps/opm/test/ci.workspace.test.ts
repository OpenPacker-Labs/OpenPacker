import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
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

/**
 * A workspace of two members: `web` needs `lib` (a member) and `left`;
 * `lib` needs `right`, and `dev-tool` for development. The project needs
 * `top`.
 */
async function workspace(
  edit: (lock: Record<string, unknown>) => void = () => {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-ws-'));
  temps.push(dir);
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-ws-store-'));
  temps.push(store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const urls: string[] = [];
  const packages: Record<string, unknown> = {};
  const add = (name: string, extra: Record<string, unknown> = {}) => {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({ name, version: '1.0.0' }),
        ),
      },
    ]);
    const url = `${ORIGIN}/${name}/-/${name}-1.0.0.tgz`;
    archives.set(url, bytes);
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: url,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      ...extra,
    };
  };
  add('top');
  add('left');
  add('right');
  add('dev-tool', { dev: true });
  const members: Record<string, Record<string, unknown>> = {
    'packages/web': {
      name: 'web',
      version: '1.0.0',
      dependencies: { lib: '^1.0.0', left: '^1.0.0' },
    },
    'packages/lib': {
      name: 'lib',
      version: '1.0.0',
      dependencies: { right: '^1.0.0' },
      devDependencies: { 'dev-tool': '^1.0.0' },
    },
  };
  const root = {
    name: 'app',
    version: '1.0.0',
    workspaces: ['packages/*'],
    dependencies: { top: '^1.0.0' },
  };
  for (const [path, manifest] of Object.entries(members)) {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, path, 'package.json'), JSON.stringify(manifest));
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(root));
  const lock: Record<string, unknown> = {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': root,
      ...members,
      'node_modules/web': { resolved: 'packages/web', link: true },
      'node_modules/lib': { resolved: 'packages/lib', link: true },
      ...packages,
    },
  };
  edit(lock);
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
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

async function ci(
  p: Awaited<ReturnType<typeof workspace>>,
  ...flags: string[]
) {
  const c = capture();
  const code = await runOpm(['ci', '--path', p.dir, ...flags], c.io, '/', {
    fetch: p.fetcher,
  });
  return { code, out: c.out, err: c.err };
}

describe('opm ci in a workspace', () => {
  it('links the members, installs the rest, and says so', async () => {
    const p = await workspace();
    const { code, out, err } = await ci(p);
    expect(err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    expect(await names(p.dir)).toEqual([
      'dev-tool',
      'left',
      'lib',
      'right',
      'top',
      'web',
    ]);
    // A junction (Windows) holds an absolute path.
    if (process.platform !== 'win32')
      expect(await readlink(join(p.dir, 'node_modules/web'))).toBe(
        '../packages/web',
      );
    expect(out).toMatch(/^Installed 4 packages into /u);
    expect(out).toContain(
      '  workspace: 2 of 2 members linked, not fetched; their scripts are not run\n',
    );
    expect(p.urls.some((url) => /\/(web|lib)\//u.test(url))).toBe(false);
  });

  it('takes --workspace, -w and --workspace=, repeated or not', async () => {
    for (const flags of [
      ['--workspace', 'lib'],
      ['-w', 'lib'],
      ['--workspace=lib'],
      ['-w', 'packages/lib'],
    ]) {
      const p = await workspace();
      const { code, out } = await ci(p, ...flags);
      expect(code, flags.join(' ')).toBe(EXIT_CODES.success);
      expect(await names(p.dir)).toEqual(['dev-tool', 'lib', 'right']);
      expect(out).toContain('  workspace: 1 of 2 members linked');
      expect(out).toContain('left out: 2 outside the workspaces selected');
    }
    const both = await workspace();
    await ci(both, '-w', 'lib', '-w', 'web');
    expect(await names(both.dir)).toEqual([
      'dev-tool',
      'left',
      'lib',
      'right',
      'web',
    ]);
  });

  it("adds the project's own dependencies with --include-workspace-root", async () => {
    const p = await workspace();
    await ci(p, '-w', 'lib', '--include-workspace-root');
    expect(await names(p.dir)).toEqual(['dev-tool', 'lib', 'right', 'top']);
  });

  it('takes --workspaces for every member and not the project', async () => {
    const p = await workspace();
    await ci(p, '--workspaces');
    expect(await names(p.dir)).toEqual([
      'dev-tool',
      'left',
      'lib',
      'right',
      'web',
    ]);
  });

  it('takes --workspaces=false and --no-workspaces for the project alone', async () => {
    for (const flag of ['--workspaces=false', '--no-workspaces']) {
      const p = await workspace();
      const { code, out } = await ci(p, flag);
      expect(code, flag).toBe(EXIT_CODES.success);
      expect(await names(p.dir)).toEqual(['top']);
      expect(out).toContain('  workspace: 0 of 2 members linked');
    }
  });

  it('applies --production to what the members need', async () => {
    const p = await workspace();
    await ci(p, '--production');
    expect(await names(p.dir)).toEqual(['left', 'lib', 'right', 'top', 'web']);
  });

  it("clears a member's node_modules the lock does not put anything in", async () => {
    const p = await workspace();
    await mkdir(join(p.dir, 'packages/web/node_modules/stale'), {
      recursive: true,
    });
    await ci(p);
    await expect(
      readdir(join(p.dir, 'packages/web/node_modules')),
    ).rejects.toThrow();
  });

  describe('refuses what it does not implement or cannot honour', () => {
    it.each([
      [['-w'], /--workspace needs a member name or directory/u],
      [['--workspace'], /--workspace needs a member name or directory/u],
      [['--workspaces=maybe'], /--workspaces takes true or false/u],
      [
        ['--include-workspace-root=1'],
        /--include-workspace-root takes true or false/u,
      ],
      [
        ['--workspaces', '--no-workspaces'],
        /only one of --workspaces or --no-workspaces/u,
      ],
      [['--workspaces=false', '-w', 'lib'], /cannot be combined/u],
      [['-w', 'nobody'], /No workspaces found: --workspace=nobody/u],
      [['stray'], /takes no package names or other arguments \(got "stray"\)/u],
      [
        ['--workspaces', 'false'],
        /takes no package names or other arguments \(got "false"\)/u,
      ],
    ])('%j', async (flags, message) => {
      const p = await workspace();
      const { code, err } = await ci(p, ...flags);
      expect(code).toBe(EXIT_CODES.invalidInput);
      expect(err).toMatch(message);
      expect(p.urls).toEqual([]);
      await expect(readdir(join(p.dir, 'node_modules'))).rejects.toThrow();
    });

    it("a link that is not a member's, with its path and why", async () => {
      const p = await workspace((lock) => {
        (lock.packages as Record<string, unknown>)['node_modules/evil'] = {
          resolved: '../outside',
          link: true,
        };
      });
      const { code, err } = await ci(p);
      expect(code).toBe(EXIT_CODES.invalidInput);
      expect(err).toMatch(
        /node_modules\/evil: a link that points at \.\.\/outside, which leaves the project root/u,
      );
      expect(p.urls).toEqual([]);
    });

    it("a member's own link that leaves the project, by the link's name", async () => {
      const p = await workspace((lock) => {
        (lock.packages as Record<string, unknown>)['node_modules/web'] = {
          resolved: '../../..',
          link: true,
        };
      });
      const { code, err } = await ci(p);
      expect(code).toBe(EXIT_CODES.invalidInput);
      expect(err).toMatch(
        /node_modules\/web: a link that points at \.\.\/\.\.\/\.\., which leaves the project root/u,
      );
      expect(err).not.toMatch(/has no node_modules\/web link/u);
      expect(p.urls).toEqual([]);
    });
  });

  it('is described in the help', async () => {
    const c = capture();
    await runOpm(['help'], c.io, '/');
    expect(c.out).toMatch(/--workspace\|-w <name\|dir>/u);
    expect(c.out).toMatch(/--include-workspace-root/u);
    expect(c.out).toMatch(/--workspaces\[=false\]/u);
  });
});
