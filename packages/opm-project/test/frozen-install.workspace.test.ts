import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { packTarGzip } from '@openpacker/project-io';
import { installFrozen, type FrozenInstallInput } from '../src/index.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const ORIGIN = 'https://registry.npmjs.org';

interface Pkg {
  name: string;
  version: string;
  files?: Record<string, string>;
  manifest?: Record<string, unknown>;
}

function tarballOf(pkg: Pkg): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      ...pkg.manifest,
    }),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  return packTarGzip(
    Object.entries(files).map(([path, text]) => ({
      path: `package/${path}`,
      contents: new TextEncoder().encode(text),
      executable: path.startsWith('bin/'),
    })),
  );
}

class FakeRegistry implements HttpTransport {
  readonly requests: string[] = [];
  readonly archives = new Map<string, Uint8Array>();
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request.url);
    const body = this.archives.get(request.url);
    if (body === undefined)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `no archive at ${request.url}`,
      );
    return { status: 200, headers: {}, body, url: request.url };
  }
}

const sri = (bytes: Uint8Array) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A workspace on disk, its lock, and a registry that serves the lock's packages. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-ws-'));
  temps.push(dir, `${dir}-store`);
  const registry = new FakeRegistry();
  const members = new Map<string, Record<string, unknown>>();
  const lockEntries: Record<string, unknown> = {};
  const rootManifest: Record<string, unknown> = {
    name: 'app',
    version: '1.0.0',
    workspaces: ['packages/*'],
  };
  const urlOf = (pkg: Pkg) =>
    `${ORIGIN}/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`;
  const world = {
    dir,
    registry,
    root: rootManifest,
    /** A registry package in the lock at `path`. */
    place(path: string, pkg: Pkg, extra: Record<string, unknown> = {}) {
      const bytes = tarballOf(pkg);
      registry.archives.set(urlOf(pkg), bytes);
      lockEntries[path] = {
        version: pkg.version,
        resolved: urlOf(pkg),
        integrity: sri(bytes),
        ...extra,
      };
    },
    /** A member: its directory, its manifest, and its link, as npm writes them. */
    member(
      name: string,
      manifest: Record<string, unknown> = {},
      options: { dir?: string; link?: boolean } = {},
    ) {
      const memberDir = options.dir ?? `packages/${name.split('/').at(-1)}`;
      const record = { name, version: '1.0.0', main: 'index.js', ...manifest };
      members.set(memberDir, record);
      if (options.link !== false)
        lockEntries[`node_modules/${name}`] = {
          resolved: memberDir,
          link: true,
        };
      return memberDir;
    },
    raw(path: string, entry: unknown) {
      lockEntries[path] = entry;
    },
    /** Write the project: member sources, the root manifest, the lock. */
    async write(
      options: { lockMembers?: Record<string, Record<string, unknown>> } = {},
    ) {
      for (const [memberDir, record] of members) {
        await mkdir(join(dir, memberDir), { recursive: true });
        await writeFile(
          join(dir, memberDir, 'package.json'),
          JSON.stringify(record),
        );
        await writeFile(
          join(dir, memberDir, 'index.js'),
          `module.exports = ${JSON.stringify(`member ${String(record.name)}`)};\n`,
        );
      }
      await writeFile(join(dir, 'package.json'), JSON.stringify(rootManifest));
      const recorded = options.lockMembers ?? Object.fromEntries(members);
      await writeFile(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': rootManifest, ...recorded, ...lockEntries },
        }),
      );
    },
    install(extra: Partial<FrozenInstallInput> = {}) {
      return installFrozen({
        root: dir,
        transport: registry,
        env: { OPM_STORE_HOME: join(dir, '..', `${basename(dir)}-store`) },
        now: () => '2026-10-12T12:00:00.000Z',
        ...extra,
      });
    },
    run(script: string, from = ''): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: join(dir, from),
        encoding: 'utf8',
      }).trim();
    },
    read: (path: string) => readFile(join(dir, path), 'utf8'),
    list: (path: string) =>
      readdir(join(dir, path)).then((names) => names.sort()),
    async isLink(path: string) {
      return (await lstat(join(dir, path))).isSymbolicLink();
    },
  };
  return world;
}

/** Shims are run through `sh`; links are junctions with absolute text on Windows. */
const onPosix = it.skipIf(process.platform === 'win32');

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A workspace of two members, each wanting a version of `left`; `one` needs `two`. */
async function standard(
  extra: (w: Awaited<ReturnType<typeof setup>>) => void = () => {},
) {
  const w = await setup();
  w.root.dependencies = { a: '^1.0.0', left: '^1.0.0' };
  w.root.devDependencies = { t: '^1.0.0' };
  w.place('node_modules/a', { name: 'a', version: '1.0.0' });
  w.place('node_modules/t', { name: 't', version: '1.0.0' }, { dev: true });
  w.place('node_modules/left', { name: 'left', version: '1.0.0' });
  w.place('packages/one/node_modules/left', { name: 'left', version: '0.9.0' });
  w.place('node_modules/b', { name: 'b', version: '1.0.0' });
  w.place('node_modules/dd', { name: 'dd', version: '1.0.0' }, { dev: true });
  w.member('one', {
    dependencies: { left: '^0.9.0', two: '^1.0.0', a: '^1.0.0' },
    scripts: {
      postinstall: "node -e \"require('fs').writeFileSync('ran','x')\"",
    },
  });
  w.member('two', {
    dependencies: { b: '^1.0.0' },
    devDependencies: { dd: '^1.0.0' },
    bin: { two: 'bin/two.js' },
  });
  extra(w);
  return w;
}

describe('installFrozen on a workspace lock', () => {
  it('links each member to its directory and gives it the node_modules the lock describes', async () => {
    const w = await standard();
    await w.write();

    const result = await w.install();

    expect(result.workspace).toEqual({ members: 2, linked: 2 });
    expect(result.installed).toBe(6);
    expect(await w.isLink('node_modules/one')).toBe(true);
    // A junction (Windows) holds an absolute path.
    if (process.platform !== 'win32')
      expect(await readlink(join(w.dir, 'node_modules', 'one'))).toBe(
        '../packages/one',
      );
    expect(w.run("console.log(require('one'), require('two'))")).toBe(
      'member one member two',
    );
    // Each member finds its own version first, the project's second, and the
    // other member through the project's link.
    expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
      'left@0.9.0',
    );
    expect(w.run("console.log(require('left'))")).toBe('left@1.0.0');
    expect(
      w.run("console.log(require('two'), require('a'))", 'packages/one'),
    ).toBe('member two a@1.0.0');
    expect(await w.isLink('packages/one/node_modules/left')).toBe(false);
  });

  it('never fetches a member, and runs none of its scripts', async () => {
    const w = await standard();
    await w.write();
    await w.install();
    expect(w.registry.requests.some((url) => /\/(one|two)\//u.test(url))).toBe(
      false,
    );
    expect(w.registry.requests).toHaveLength(6);
    expect(await exists(join(w.dir, 'packages', 'one', 'ran'))).toBe(false);
  });

  onPosix(
    "shims the executables of a member in the project's .bin, which run the member's script",
    async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'packages/two/bin'), { recursive: true });
      await writeFile(
        join(w.dir, 'packages/two/bin/two.js'),
        "#!/usr/bin/env node\nconsole.log('two ran', process.argv.slice(2).join())\n",
      );
      const result = await w.install();
      expect(await w.isLink('node_modules/.bin/two')).toBe(false);
      expect(
        execFileSync('sh', [join(w.dir, 'node_modules/.bin/two'), 'x'], {
          encoding: 'utf8',
        }),
      ).toBe('two ran x\n');
      expect(result.layout.semanticLoss[0]?.representedMeaning).toMatch(
        /2 workspace member\(s\) linked to their own directories, 1 with a node_modules of their own/u,
      );
    },
  );

  it("clears every member's node_modules and the project's first, as npm ci does", async () => {
    const w = await standard();
    await w.write();
    for (const stale of [
      'node_modules/stale',
      'packages/one/node_modules/stale',
      'packages/two/node_modules/stale',
    ]) {
      await mkdir(join(w.dir, stale), { recursive: true });
      await writeFile(join(w.dir, stale, 'package.json'), '{}');
    }
    await w.install();
    expect(await w.list('node_modules')).not.toContain('stale');
    expect(await w.list('packages/one/node_modules')).toEqual([
      '.opm-layout.json',
      'left',
    ]);
    // `two` has no packages of its own, so it has no node_modules now.
    expect(await exists(join(w.dir, 'packages/two/node_modules'))).toBe(false);
  });

  it('does it again for nothing', async () => {
    const w = await standard();
    await w.write();
    await w.install();
    const first = await w.list('node_modules');
    const again = await w.install();
    expect(await w.list('node_modules')).toEqual(first);
    expect(again.fetched).toBe(0);
    expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
      'left@0.9.0',
    );
  });

  describe('--workspace', () => {
    it('installs the named member and what it needs, and clears the others', async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'packages/one/node_modules/stale'), {
        recursive: true,
      });
      const result = await w.install({ workspace: { select: ['two'] } });
      expect(result.workspace).toEqual({ members: 2, linked: 1 });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['b', 'dd', 'two']);
      expect(await exists(join(w.dir, 'packages/one/node_modules'))).toBe(
        false,
      );
      expect(result.skipped.filter((s) => s.kind === 'workspace')).toHaveLength(
        4,
      );
    });

    it('takes a directory, and the directory of its members', async () => {
      const w = await standard();
      await w.write();
      const byDirectory = await w.install({
        workspace: { select: ['packages/two'] },
      });
      const byParent = await w.install({ workspace: { select: ['packages'] } });
      expect(byDirectory.workspace?.linked).toBe(1);
      expect(byParent.workspace?.linked).toBe(2);
    });

    it("takes the project's own dependencies along with the root", async () => {
      const w = await standard();
      await w.write();
      await w.install({ workspace: { select: ['two'], includeRoot: true } });
      expect(await w.list('node_modules')).toEqual(
        expect.arrayContaining(['a', 'b', 'dd', 'left', 't', 'two']),
      );
      expect(await w.list('node_modules')).not.toContain('one');
    });

    it('is not an install at all when it names no member', async () => {
      const w = await standard();
      await w.write();
      await mkdir(join(w.dir, 'node_modules/keep'), { recursive: true });
      await expect(
        w.install({ workspace: { select: ['nobody'] } }),
      ).rejects.toMatchObject({
        code: 'INVALID_SPEC',
        message: expect.stringMatching(
          /No workspaces found: --workspace=nobody/u,
        ),
      });
      expect(await exists(join(w.dir, 'node_modules/keep'))).toBe(true);
    });

    it('applies --omit to what the member needs', async () => {
      const w = await standard();
      await w.write();
      await w.install({ omit: ['dev'], workspace: { select: ['two'] } });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['b', 'two']);
    });
  });

  describe('--workspaces', () => {
    it("installs every member and not the project's own dependencies", async () => {
      const w = await standard();
      await w.write();
      await w.install({ workspace: { all: true } });
      const names = await w.list('node_modules');
      expect(names).toEqual(expect.arrayContaining(['one', 'two', 'b', 'a']));
      // Named by the project alone, and by no member.
      expect(names).not.toContain('t');
      expect(names).not.toContain('left');
      expect(w.run("console.log(require('left'))", 'packages/one')).toBe(
        'left@0.9.0',
      );
    });

    it("=false installs the project's own dependencies and links no member", async () => {
      const w = await standard();
      await w.write();
      const result = await w.install({ workspace: { ignore: true } });
      expect(result.workspace).toEqual({ members: 2, linked: 0 });
      expect(
        (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
      ).toEqual(['a', 'left', 't']);
    });

    it('=false cannot be combined with a selection', async () => {
      const w = await standard();
      await w.write();
      await expect(
        w.install({ workspace: { ignore: true, select: ['one'] } }),
      ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    });
  });

  it("applies --omit=dev to a member's development dependencies", async () => {
    const w = await standard();
    await w.write();
    await w.install({ omit: ['dev'] });
    expect(await w.list('node_modules')).not.toContain('dd');
    expect(await w.list('node_modules')).not.toContain('t');
    expect(await w.list('node_modules')).toContain('two');
  });
});

describe('installFrozen refuses, before it fetches or writes anything', () => {
  async function refused(
    w: Awaited<ReturnType<typeof setup>>,
    code: string,
    text: RegExp,
  ) {
    await mkdir(join(w.dir, 'node_modules/keep'), { recursive: true });
    await expect(w.install()).rejects.toMatchObject({
      code,
      message: expect.stringMatching(text),
    });
    expect(w.registry.requests).toEqual([]);
    expect(await exists(join(w.dir, 'node_modules/keep'))).toBe(true);
    expect(await exists(join(w.dir, 'node_modules/one'))).toBe(false);
  }

  it('a link to a place outside the project', async () => {
    const w = await standard((x) =>
      x.raw('node_modules/evil', { resolved: '../outside', link: true }),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/evil: a link that points at \.\.\/outside, which leaves the project root/u,
    );
  });

  it('a link to a directory the workspaces do not select', async () => {
    const w = await standard((x) => {
      x.raw('node_modules/vendored', {
        resolved: 'vendor/vendored',
        link: true,
      });
      x.raw('vendor/vendored', { name: 'vendored', version: '1.0.0' });
    });
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /vendor\/vendored: not a workspace member/u,
    );
  });

  it("a link under a name that is not the member's", async () => {
    const w = await standard((x) =>
      x.raw('node_modules/alias', { resolved: 'packages/one', link: true }),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/alias: a link named alias to the member one/u,
    );
  });

  it('a package bundled in a member', async () => {
    const w = await standard((x) =>
      x.place(
        'packages/one/node_modules/bundled',
        { name: 'bundled', version: '1.0.0' },
        { inBundle: true },
      ),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /bundled@1\.0\.0 is bundled in the workspace member packages\/one/u,
    );
  });

  it('a lock that lists a member the disk does not have', async () => {
    const w = await standard();
    await w.write();
    await rm(join(w.dir, 'packages/two'), { recursive: true });
    await refused(
      w,
      'INVALID_LOCK',
      /the lock lists the members packages\/one, packages\/two; the project declares the members packages\/one; packages\/two \(two\) is a member in the lock and is not on disk/su,
    );
  });

  it('a member on disk that the lock does not have', async () => {
    const w = await standard();
    await w.write();
    await mkdir(join(w.dir, 'packages/three'));
    await writeFile(
      join(w.dir, 'packages/three/package.json'),
      '{"name":"three","version":"1.0.0"}',
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/three \(three\) is a member on disk and is not in the lock/u,
    );
  });

  it('two members on disk with one name', async () => {
    const w = await standard();
    await w.write();
    await mkdir(join(w.dir, 'packages/dup'));
    await writeFile(
      join(w.dir, 'packages/dup/package.json'),
      '{"name":"one","version":"1.0.0"}',
    );
    await refused(
      w,
      'INVALID_MANIFEST',
      /Two workspace members are named "one"/u,
    );
  });

  it('two members in the lock with one name', async () => {
    const w = await standard();
    w.root.workspaces = ['packages/*', 'tools/*'];
    await w.write({
      lockMembers: {
        'packages/one': { name: 'one', version: '1.0.0' },
        'tools/one': { name: 'one', version: '1.0.0' },
        'packages/two': { name: 'two', version: '1.0.0' },
      },
    });
    await refused(
      w,
      'INVALID_LOCK',
      /Two workspace members are named "one": packages\/one, tools\/one/u,
    );
  });

  it('a member whose manifest lists a dependency the lock lacks', async () => {
    const w = await standard();
    await w.write();
    const manifest = JSON.parse(await w.read('packages/two/package.json'));
    manifest.dependencies.missing = '^1.0.0';
    await writeFile(
      join(w.dir, 'packages/two/package.json'),
      JSON.stringify(manifest),
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/two: dependencies\.missing is in package\.json and not in the lock/u,
    );
  });

  it('a member whose lock entry names a dependency the lock has no entry for', async () => {
    const w = await standard();
    const broken = {
      'packages/one': {
        name: 'one',
        version: '1.0.0',
        dependencies: { left: '^0.9.0', two: '^1.0.0', a: '^1.0.0', gone: '1' },
      },
      'packages/two': {
        name: 'two',
        version: '1.0.0',
        dependencies: { b: '^1.0.0' },
        devDependencies: { dd: '^1.0.0' },
        bin: { two: 'bin/two.js' },
      },
    };
    await w.write({ lockMembers: broken });
    const manifest = JSON.parse(await w.read('packages/one/package.json'));
    manifest.dependencies.gone = '1';
    await writeFile(
      join(w.dir, 'packages/one/package.json'),
      JSON.stringify(manifest),
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/one: gone \(dependencies\) has no entry in the lock/u,
    );
  });

  it('a workspace reached through a link', async () => {
    const w = await standard();
    await w.write();
    const real = join(w.dir, '..', `real-packages-${Date.now()}`);
    temps.push(real);
    await mkdir(dirname(real), { recursive: true });
    await rm(join(w.dir, 'packages'), { recursive: true });
    await mkdir(join(real, 'one'), { recursive: true });
    await writeFile(
      join(real, 'one/package.json'),
      '{"name":"one","version":"1.0.0"}',
    );
    await symlink(real, join(w.dir, 'packages'));
    await refused(w, 'UNSAFE_PATH', /packages/u);
  });
});

describe('a project without a workspace', () => {
  it('is installed as it always was, and refuses a workspace flag', async () => {
    const w = await setup();
    delete w.root.workspaces;
    w.root.dependencies = { a: '^1.0.0' };
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    await w.write();
    const result = await w.install();
    expect(result.workspace).toBeUndefined();
    expect(result.installed).toBe(1);
    // npm accepts -w in a project with no workspaces and finds none.
    await expect(
      w.install({ workspace: { select: ['a'] } }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringMatching(/No workspaces found/u),
    });
  });

  it('is never put through workspace discovery, which reads manifests more strictly than npm ci does', async () => {
    const w = await setup();
    delete w.root.workspaces;
    // Not SemVer 2.0, which discovery refuses and an ordinary install never read.
    w.root.version = '1.0';
    w.root.dependencies = { a: '^1.0.0' };
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    await w.write();
    expect((await w.install()).installed).toBe(1);
  });

  it('is put through it once it declares a workspace', async () => {
    const w = await setup();
    w.root.version = '1.0';
    await w.write();
    await expect(w.install()).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
      message: expect.stringMatching(
        /version "1\.0" is not a semantic version/u,
      ),
    });
  });
});
