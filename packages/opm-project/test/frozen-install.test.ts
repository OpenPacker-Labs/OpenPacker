import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { gzipSync } from 'node:zlib';
import { packTarGzip } from '@openpacker/project-io';
import {
  collectSharedStore,
  installFrozen,
  type FrozenInstallInput,
} from '../src/index.js';
import { uniqueBytes } from './disk-usage.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const ORIGIN = 'https://registry.npmjs.org';

/** Bytes that do not compress away, the same every time for the same seed. */
function noise(seed: string, length: number): string {
  let out = '';
  for (let index = 0; out.length < length; index += 1)
    out += createHash('sha256').update(`${seed}:${index}`).digest('hex');
  return out.slice(0, length);
}

interface Pkg {
  name: string;
  version: string;
  /** Extra files, and overrides of index.js / package.json fields. */
  files?: Record<string, string>;
  manifest?: Record<string, unknown>;
}

function tarballOf(pkg: Pkg): Uint8Array {
  const base = {
    name: pkg.name,
    version: pkg.version,
    main: 'index.js',
    ...pkg.manifest,
  };
  const files: Record<string, string> = {
    'package.json': JSON.stringify(base),
    'index.js': `module.exports = { name: ${JSON.stringify(pkg.name)}, version: ${JSON.stringify(pkg.version)} };\n`,
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

/**
 * A gzipped tar with entries spelled exactly as given: `./` segments and a
 * path listed twice, which `packTarGzip` refuses to write.
 */
function rawTarball(entries: { name: string; data: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const { name, data } of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(
      `${body.length.toString(8).padStart(11, '0')}\0`,
      124,
      'ascii',
    );
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0' + '00', 257, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

/** A registry that serves what it was given, and remembers what it was asked. */
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

/** A project directory, a lock for it, and a registry that serves the lock. */
async function setup() {
  const dir = await tempDir('frozen-install-');
  const registry = new FakeRegistry();
  const entries: Record<string, unknown> = {};
  const rootDependencies: Record<string, Record<string, string>> = {};
  const urlOf = (pkg: Pkg) =>
    `${ORIGIN}/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`;
  return {
    dir,
    registry,
    /** Lock `pkg` at `path`, and serve its archive. */
    place(path: string, pkg: Pkg, extra: Record<string, unknown> = {}): Pkg {
      const bytes = tarballOf(pkg);
      registry.archives.set(urlOf(pkg), bytes);
      entries[path] = {
        version: pkg.version,
        resolved: urlOf(pkg),
        integrity: sri(bytes),
        ...extra,
      };
      return pkg;
    },
    /** Declare a dependency of the project itself. */
    root(field: string, name: string, spec: string): void {
      (rootDependencies[field] ??= {})[name] = spec;
    },
    raw(path: string, entry: unknown): void {
      entries[path] = entry;
    },
    async write(extraManifest: Record<string, unknown> = {}): Promise<void> {
      const manifest = {
        name: 'app',
        version: '1.0.0',
        ...rootDependencies,
        ...extraManifest,
      };
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
      await writeFile(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': manifest, ...entries },
        }),
      );
    },
    install(extra: Partial<FrozenInstallInput> = {}) {
      return installFrozen({
        root: dir,
        transport: registry,
        env: {},
        now: () => '2026-10-11T12:00:00.000Z',
        ...extra,
      });
    },
    read: async (path: string) => readFile(join(dir, path), 'utf8'),
    run(script: string): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;

describe('installFrozen', () => {
  it('installs the tree the lock describes, each version where the lock puts it', async () => {
    const w = await setup();
    const needsC = (range: string) => ({
      files: {
        'index.js': `module.exports = { c: require('c').version };\n`,
      },
      manifest: { dependencies: { c: range } },
    });
    w.place(
      'node_modules/a',
      { name: 'a', version: '1.0.0', ...needsC('^1.0.0') },
      {
        dependencies: { c: '^1.0.0' },
      },
    );
    w.place(
      'node_modules/b',
      { name: 'b', version: '1.0.0', ...needsC('^2.0.0') },
      {
        dependencies: { c: '^2.0.0' },
      },
    );
    w.place('node_modules/c', { name: 'c', version: '1.0.0' });
    w.place('node_modules/b/node_modules/c', { name: 'c', version: '2.0.0' });
    w.root('dependencies', 'a', '^1.0.0');
    w.root('dependencies', 'b', '^1.0.0');
    await w.write();

    const result = await w.install();

    expect(result.installed).toBe(4);
    expect(result.fetched).toBe(4);
    expect(
      w.run(
        "console.log(require('a').c, require('b').c, require('c').version)",
      ),
    ).toBe('1.0.0 2.0.0 1.0.0');
    expect(
      JSON.parse(await w.read('node_modules/b/node_modules/c/package.json'))
        .version,
    ).toBe('2.0.0');
  });

  it("installs a package the way npm's extractor reads it: `./` segments and a repeated file", async () => {
    const w = await setup();
    const bytes = rawTarball([
      {
        name: 'package/package.json',
        data: '{"name":"agent-base","version":"7.1.4","main":"dist/index.js"}',
      },
      { name: 'package/./dist/index.js', data: 'module.exports = "agent";\n' },
      { name: 'package/dist/index.js', data: 'module.exports = "agent";\n' },
    ]);
    const url = `${ORIGIN}/agent-base/-/agent-base-7.1.4.tgz`;
    w.registry.archives.set(url, bytes);
    w.raw('node_modules/agent-base', {
      version: '7.1.4',
      resolved: url,
      integrity: sri(bytes),
    });
    w.root('dependencies', 'agent-base', '7.1.4');
    await w.write();

    await w.install();

    expect(w.run("console.log(require('agent-base'))")).toBe('agent');
  });

  it('still refuses a package that lists one path with two different contents', async () => {
    const w = await setup();
    const bytes = rawTarball([
      {
        name: 'package/package.json',
        data: '{"name":"liar","version":"1.0.0"}',
      },
      { name: 'package/index.js', data: 'safe' },
      { name: 'package/./index.js', data: 'malicious' },
    ]);
    const url = `${ORIGIN}/liar/-/liar-1.0.0.tgz`;
    w.registry.archives.set(url, bytes);
    w.raw('node_modules/liar', {
      version: '1.0.0',
      resolved: url,
      integrity: sri(bytes),
    });
    w.root('dependencies', 'liar', '1.0.0');
    await w.write();

    await expect(w.install()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringMatching(
        /liar@1\.0\.0 \(node_modules\/liar\) cannot be extracted.*DUPLICATE_PATH/su,
      ),
    });
  });

  it('proves every archive against the integrity in the lock before using it', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();
    // The registry now serves different bytes than the lock pinned.
    w.registry.archives.set(
      `${ORIGIN}/a/-/a-1.0.0.tgz`,
      tarballOf({ name: 'a', version: '1.0.0', files: { 'evil.js': 'x' } }),
    );
    await mkdir(join(w.dir, 'node_modules/keep'), { recursive: true });
    await writeFile(join(w.dir, 'node_modules/keep/file'), 'still here');

    await expect(w.install()).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
      message: expect.stringMatching(
        /a@1\.0\.0 \(node_modules\/a\) does not match the integrity the lock pins.*Nothing was installed from it/u,
      ),
    });
    // A failed install does not touch what was there.
    expect(await w.read('node_modules/keep/file')).toBe('still here');
  });

  it('takes archives from the shared store and fetches nothing the second time', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.place('node_modules/b', { name: 'b', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    w.root('dependencies', 'b', '1.0.0');
    await w.write();
    const store = await tempDir('frozen-store-');
    const env = { OPM_STORE_HOME: join(store, 'shared') };

    const first = await w.install({ env });
    expect(first).toMatchObject({ fetched: 2, fromStore: 0, shared: true });
    expect(w.registry.requests).toHaveLength(2);

    await rm(join(w.dir, 'node_modules'), { recursive: true });
    const second = await w.install({ env, offline: true });
    expect(second).toMatchObject({ fetched: 0, fromStore: 2, shared: true });
    expect(w.registry.requests).toHaveLength(2);
    expect(w.run("console.log(require('a').version)")).toBe('1.0.0');
    // node_modules shares its inodes with the store.
    expect(
      (await lstat(join(w.dir, 'node_modules/a/index.js'))).nlink,
    ).toBeGreaterThan(1);
  });

  it('keeps what a project links from being collected, and refetches what was', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();
    const store = await tempDir('frozen-store-');
    const env = { OPM_STORE_HOME: join(store, 'shared') };

    await w.install({ env });
    // The project still links the entry, so collecting it leaves it alone.
    const held = await collectSharedStore({ env, minimumAgeMs: 0 });
    expect(held).toMatchObject({ referenced: 1, removed: [] });

    // Once nothing links it, it goes; the index still names it, which must
    // cost a download and not a failure.
    await rm(join(w.dir, 'node_modules'), { recursive: true });
    const freed = await collectSharedStore({ env, minimumAgeMs: 0 });
    expect(freed.removed).toHaveLength(1);
    await expect(w.install({ env, offline: true })).rejects.toMatchObject({
      code: 'OFFLINE',
    });
    const again = await w.install({ env });
    expect(again).toMatchObject({ fetched: 1, fromStore: 0 });
    expect(w.run("console.log(require('a').version)")).toBe('1.0.0');
  });

  it('installs a lock with nothing in it', async () => {
    const w = await setup();
    await w.write();
    await mkdir(join(w.dir, 'node_modules/old'), { recursive: true });
    const result = await w.install();
    expect(result).toMatchObject({ installed: 0, fetched: 0, fromStore: 0 });
    expect(await exists(join(w.dir, 'node_modules/old'))).toBe(false);
  });

  it('costs a second project almost nothing', async () => {
    const store = await tempDir('frozen-store-');
    const env = { OPM_STORE_HOME: join(store, 'shared') };
    const projects = [];
    for (let index = 0; index < 2; index += 1) {
      const w = await setup();
      for (let n = 0; n < 12; n += 1) {
        w.place(`node_modules/p${n}`, {
          name: `p${n}`,
          version: '1.0.0',
          files: {
            'data.txt': noise(`data${n}`, 300_000),
            'lib/more.js': noise(`code${n}`, 8_000),
          },
        });
        w.root('dependencies', `p${n}`, '1.0.0');
      }
      await w.write();
      await w.install({ env });
      projects.push(w.dir);
    }
    const [first, second] = projects as [string, string];
    const both = await uniqueBytes([
      join(store, 'shared'),
      join(first, 'node_modules'),
      join(second, 'node_modules'),
    ]);
    const one = await uniqueBytes([
      join(store, 'shared'),
      join(first, 'node_modules'),
    ]);
    expect((both - one) / one).toBeLessThan(0.05);
  });

  it('is offline when asked and the store does not have it, naming what is missing', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.place('node_modules/b', { name: 'b', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    w.root('dependencies', 'b', '1.0.0');
    await w.write();
    const store = await tempDir('frozen-store-');
    await expect(
      w.install({ env: { OPM_STORE_HOME: join(store, 's') }, offline: true }),
    ).rejects.toMatchObject({
      code: 'OFFLINE',
      message: expect.stringMatching(
        /2 packages are not in the local store.*a@1\.0\.0.*b@1\.0\.0/su,
      ),
    });
    expect(w.registry.requests).toEqual([]);
  });

  it('works without a shared store, leaves nothing behind, and leaves files editable', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();

    const result = await w.install({ env: { OPM_STORE_HOME: 'off' } });

    expect(result.shared).toBe(false);
    expect((await readdir(w.dir)).sort()).toEqual([
      'node_modules',
      'package-lock.json',
      'package.json',
    ]);
    const mode = (await stat(join(w.dir, 'node_modules/a/index.js'))).mode;
    expect(mode & 0o200).not.toBe(0);
  });

  it('replaces whatever node_modules held, so it is exactly the lock', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();
    await mkdir(join(w.dir, 'node_modules/stale'), { recursive: true });
    await writeFile(join(w.dir, 'node_modules/stale/index.js'), 'old');
    await mkdir(join(w.dir, 'node_modules/a'), { recursive: true });
    await writeFile(join(w.dir, 'node_modules/a/leftover.js'), 'old');

    await w.install();

    expect(await exists(join(w.dir, 'node_modules/stale'))).toBe(false);
    expect(await exists(join(w.dir, 'node_modules/a/leftover.js'))).toBe(false);
    expect(await exists(join(w.dir, 'node_modules/a/index.js'))).toBe(true);
  });

  it('writes .bin shims that run', async () => {
    const w = await setup();
    w.place('node_modules/tool', {
      name: 'tool',
      version: '1.0.0',
      manifest: { bin: { tool: 'bin/tool.js' } },
      files: {
        'bin/tool.js': "#!/usr/bin/env node\nconsole.log('tool ran')\n",
      },
    });
    w.root('dependencies', 'tool', '1.0.0');
    await w.write();

    await w.install();

    expect(
      execFileSync(join(w.dir, 'node_modules/.bin/tool'), {
        encoding: 'utf8',
      }).trim(),
    ).toBe('tool ran');
  });

  it('leaves out dev packages for a production install, and optional ones for another platform', async () => {
    const w = await setup();
    w.place('node_modules/runtime', { name: 'runtime', version: '1.0.0' });
    w.place(
      'node_modules/test-tool',
      { name: 'test-tool', version: '1.0.0' },
      { dev: true },
    );
    w.place(
      'node_modules/native-linux',
      { name: 'native-linux', version: '1.0.0' },
      {
        optional: true,
        os: ['linux'],
      },
    );
    w.place(
      'node_modules/native-mac',
      { name: 'native-mac', version: '1.0.0' },
      {
        optional: true,
        os: ['darwin'],
      },
    );
    w.root('dependencies', 'runtime', '1.0.0');
    w.root('devDependencies', 'test-tool', '1.0.0');
    w.root('optionalDependencies', 'native-linux', '1.0.0');
    w.root('optionalDependencies', 'native-mac', '1.0.0');
    await w.write();

    const result = await w.install({ omit: ['dev'], target: linux });

    expect(
      (await readdir(join(w.dir, 'node_modules')))
        .filter((name) => !name.startsWith('.'))
        .sort(),
    ).toEqual(['native-linux', 'runtime']);
    expect(result.skipped.map((item) => item.name).sort()).toEqual([
      'native-mac',
      'test-tool',
    ]);
    // Neither was downloaded.
    expect(w.registry.requests.some((url) => url.includes('native-mac'))).toBe(
      false,
    );
    expect(w.registry.requests.some((url) => url.includes('test-tool'))).toBe(
      false,
    );
  });

  it('reports install scripts and runs none of them', async () => {
    const w = await setup();
    w.place(
      'node_modules/builds',
      {
        name: 'builds',
        version: '2.0.0',
        manifest: {
          scripts: { postinstall: "require('fs').writeFileSync('ran','x')" },
        },
      },
      { hasInstallScript: true },
    );
    w.root('dependencies', 'builds', '2.0.0');
    await w.write();

    const result = await w.install();

    expect(result.installScripts).toEqual([
      { name: 'builds', version: '2.0.0', path: 'node_modules/builds' },
    ]);
    expect(await exists(join(w.dir, 'node_modules/builds/ran'))).toBe(false);
    expect(await exists(join(w.dir, 'ran'))).toBe(false);
  });

  it('refuses a workspace lock, listing the members, before it fetches anything', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.raw('node_modules/@app/one', { resolved: 'packages/one', link: true });
    w.raw('packages/one', { name: '@app/one', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write({ workspaces: ['packages/*'] });

    await expect(w.install()).rejects.toMatchObject({
      code: 'UNSUPPORTED_LOCK',
      message: expect.stringMatching(
        /node_modules\/@app\/one: a link to packages\/one.*packages\/one: a workspace member \(@app\/one\)/su,
      ),
    });
    expect(w.registry.requests).toEqual([]);
  });

  it('applies the project policy to every package before fetching any', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.raw('node_modules/a/node_modules/url-dep', {
      version: '1.0.0',
      resolved: 'https://example.com/builds/url-dep.tgz',
      integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    });
    w.raw('node_modules/gitdep', {
      version: '1.0.0',
      resolved: 'git+ssh://git@github.com/o/r.git#abc',
      integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
    });
    w.root('dependencies', 'a', '1.0.0');
    w.root('dependencies', 'gitdep', 'github:o/r');
    await w.write();

    await expect(w.install()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: expect.stringMatching(
        /refuses 1 package.*node_modules\/a\/node_modules\/url-dep.*supply-chain\.exotic-source.*tarball.*dependency depth 1/su,
      ),
    });
    expect(w.registry.requests).toEqual([]);
  });

  it('will not install from a git source even where policy lets a direct one through', async () => {
    const w = await setup();
    w.raw('node_modules/gitdep', {
      version: '1.0.0',
      resolved: 'git+ssh://git@github.com/o/r.git#abc',
      integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
    });
    w.root('dependencies', 'gitdep', 'github:o/r');
    await w.write();

    await expect(w.install()).rejects.toMatchObject({
      code: 'UNSUPPORTED_LOCK',
      message: expect.stringMatching(/git or path source.*gitdep@1\.0\.0/su),
    });
  });

  it('does not apply the minimum release age to a version the lock already pinned', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();
    // The default policy asks 1440 minutes of age and the lock carries no
    // publish time; a pinned package must not be refused for that.
    await expect(w.install()).resolves.toMatchObject({ installed: 1 });
  });

  it("applies the project's own policy, not only the default", async () => {
    const w = await setup();
    w.raw('node_modules/direct-url', {
      version: '1.0.0',
      resolved: 'https://example.com/builds/direct-url.tgz',
      integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
    });
    w.root(
      'dependencies',
      'direct-url',
      'https://example.com/builds/direct-url.tgz',
    );
    await w.write();
    // The default lets a direct URL dependency through; this project does not.
    await writeFile(
      join(w.dir, 'opm.toml'),
      '[project]\nname = "app"\necosystems = ["npm"]\n\n[policy]\nblock_exotic_direct = true\nblock_exotic_transitive = true\n',
    );
    await expect(w.install()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: expect.stringMatching(
        /direct-url@1\.0\.0.*supply-chain\.exotic-source.*tarball.*dependency depth 0/su,
      ),
    });
  });

  it('refuses a lock that is not in sync with package.json', async () => {
    const w = await setup();
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    w.root('dependencies', 'a', '1.0.0');
    await w.write();
    const manifest = JSON.parse(await w.read('package.json'));
    manifest.dependencies.b = '1.0.0';
    await writeFile(join(w.dir, 'package.json'), JSON.stringify(manifest));
    await expect(w.install()).rejects.toMatchObject({
      code: 'INVALID_LOCK',
      message: expect.stringMatching(
        /not in sync.*dependencies\.b is in package\.json and not in the lock/su,
      ),
    });
  });

  it('says so when there is nothing to install from', async () => {
    const w = await setup();
    await expect(w.install()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
