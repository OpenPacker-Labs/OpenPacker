import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import {
  captureFactsFromSourceUri,
  collectSharedStore,
  defaultSharedStoreHome,
  enableDefaultSharedStore,
  initProject,
  lockPackageFromSource,
  materializeLockPackage,
  sharedStoreRoot,
  storeKeyFromDigest,
  usableSharedRoot,
} from '../src/index.js';
import {
  bindVerifiedArtifactCacheEntry,
  sealVerifiedArtifactBinding,
} from '../src/install.js';
import { sharedStoreHome } from '../src/paths.js';
import { uniqueBytes } from './disk-usage.js';
import { materializeThroughSharedStore } from './shared-store-limits.js';

const temps: string[] = [];
afterEach(async () => {
  enableDefaultSharedStore(false);
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const encode = (text: string) => new TextEncoder().encode(text);

function archive(files: Record<string, string | Uint8Array> = {}): {
  bytes: Uint8Array;
  digest: string;
} {
  const bytes = packTarGzip(
    Object.entries({
      'package.json': '{"name":"demo","version":"1.0.0"}',
      'index.js': 'module.exports = 1;\n',
      ...files,
    }).map(([path, contents]) => ({
      path: `package/${path}`,
      contents: typeof contents === 'string' ? encode(contents) : contents,
    })),
  );
  return {
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

describe('the default shared store', () => {
  it('is off in the library until a process entry turns it on', () => {
    expect(sharedStoreRoot({})).toBeUndefined();
    expect(sharedStoreRoot({ XDG_CACHE_HOME: '/somewhere' })).toBeUndefined();
  });

  it('lives beside the tool cache once enabled, and honours XDG_CACHE_HOME', () => {
    enableDefaultSharedStore();
    expect(sharedStoreRoot({ XDG_CACHE_HOME: '/xdg/cache' })).toBe(
      '/xdg/cache/openpacker/store',
    );
    expect(defaultSharedStoreHome({}, () => '/home/someone')).toBe(
      '/home/someone/.cache/openpacker/store',
    );
    // The XDG specification says a relative value is invalid and ignored.
    expect(
      defaultSharedStoreHome({ XDG_CACHE_HOME: 'relative/cache' }, () => '/h'),
    ).toBe('/h/.cache/openpacker/store');
  });

  it('is turned off by OPM_STORE_HOME=off, whatever the default', () => {
    enableDefaultSharedStore();
    for (const value of ['off', 'OFF', 'none', 'false', '0'])
      expect(sharedStoreRoot({ OPM_STORE_HOME: value })).toBeUndefined();
  });

  it('lets an absolute OPM_STORE_HOME replace the default, and treats blank as unset', () => {
    enableDefaultSharedStore();
    expect(sharedStoreRoot({ OPM_STORE_HOME: '/elsewhere' })).toBe(
      '/elsewhere',
    );
    expect(
      sharedStoreRoot({ OPM_STORE_HOME: '  ', XDG_CACHE_HOME: '/x' }),
    ).toBe('/x/openpacker/store');
  });

  it('still refuses a relative OPM_STORE_HOME', () => {
    enableDefaultSharedStore();
    expect(() => sharedStoreRoot({ OPM_STORE_HOME: 'store' })).toThrow(
      /absolute/u,
    );
    expect(() => sharedStoreHome({ OPM_STORE_HOME: './store' })).toThrow(
      /absolute/u,
    );
  });

  it('creates the default root private to its owner', async () => {
    enableDefaultSharedStore();
    const cache = await tempDir('opm-xdg-');
    const project = await tempDir('opm-proj-');

    const root = await usableSharedRoot(join(project, '.opm', 'store'), {
      XDG_CACHE_HOME: cache,
    });

    expect(root).toBe(join(cache, 'openpacker', 'store'));
    expect((await stat(root!)).mode & 0o777).toBe(0o700);
  });

  it('falls back to the project store, and does not fail, when the default is not private', async () => {
    enableDefaultSharedStore();
    const cache = await tempDir('opm-xdg-');
    const project = await tempDir('opm-proj-');
    const root = join(cache, 'openpacker', 'store');
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);

    expect(
      await usableSharedRoot(join(project, '.opm', 'store'), {
        XDG_CACHE_HOME: cache,
      }),
    ).toBeUndefined();

    const { bytes, digest } = archive();
    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath: join(project, storeKeyFromDigest(digest)),
      bytes,
      format: 'tar+gzip',
      env: { XDG_CACHE_HOME: cache },
    });
    expect(result.shared).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('does not use a default store that sits on another device than the project', async () => {
    const other = '/dev/shm';
    const here = await tempDir('opm-proj-');
    const otherDevice = await stat(other).catch(() => undefined);
    if (otherDevice === undefined || otherDevice.dev === (await stat(here)).dev)
      return; // no second filesystem to test against
    enableDefaultSharedStore();
    const cache = await mkdtemp(join(other, 'opm-xdg-'));
    temps.push(cache);

    expect(
      await usableSharedRoot(join(here, '.opm', 'store'), {
        XDG_CACHE_HOME: cache,
      }),
    ).toBeUndefined();
    // An operator who names the store gets exactly what they named.
    expect(
      await usableSharedRoot(join(here, '.opm', 'store'), {
        OPM_STORE_HOME: join(cache, 'named'),
      }),
    ).toBe(join(cache, 'named'));
  });
});

describe('an explicit shared store root', () => {
  it('is refused when other users can write to it', async () => {
    const root = await tempDir('opm-shared-open-');
    await chmod(root, 0o777);
    await expect(
      usableSharedRoot(join(root, 'project'), { OPM_STORE_HOME: root }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('is refused when it belongs to someone else', async () => {
    const root = await tempDir('opm-shared-foreign-');
    // Someone other than whoever is running this; only root can hand a
    // directory to another user, and anyone else has nothing to test.
    const other = process.geteuid?.() === 65534 ? 65533 : 65534;
    try {
      await chown(root, other, other);
    } catch {
      return;
    }
    await expect(
      usableSharedRoot(join(root, 'project'), { OPM_STORE_HOME: root }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('is refused when it is a symbolic link', async () => {
    const real = await tempDir('opm-shared-real-');
    const holder = await tempDir('opm-shared-holder-');
    await symlink(real, join(holder, 'link'));
    await expect(
      usableSharedRoot(join(holder, 'project'), {
        OPM_STORE_HOME: join(holder, 'link'),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});

describe('the shared entry', () => {
  it('holds read-only files and is linked, not copied, into each project', async () => {
    const shared = await tempDir('opm-shared-');
    const a = await tempDir('opm-proj-a-');
    const b = await tempDir('opm-proj-b-');
    const { bytes, digest } = archive();
    const env = { OPM_STORE_HOME: shared };
    const key = storeKeyFromDigest(digest);

    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(a, key),
      bytes,
      format: 'tar+gzip',
      env,
    });
    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(b, key),
      bytes,
      format: 'tar+gzip',
      env,
    });

    const entry = join(shared, key, 'package', 'index.js');
    const info = await stat(entry);
    expect(info.mode & 0o222).toBe(0);
    expect(info.nlink).toBe(3);
    expect((await stat(join(a, key, 'package', 'index.js'))).ino).toBe(
      info.ino,
    );
    expect((await stat(join(b, key, 'package', 'index.js'))).ino).toBe(
      info.ino,
    );
  });

  it('adopts a package that ships file names beyond [A-Za-z0-9._-]', async () => {
    const shared = await tempDir('opm-shared-');
    const project = await tempDir('opm-proj-');
    const names = [
      '[id].js',
      '+page.svelte',
      'README (copy).md',
      '$schema.json',
      'résumé.txt',
      '@scoped.txt',
    ];
    const { bytes, digest } = archive(
      Object.fromEntries(names.map((name) => [`lib/${name}`, `${name}\n`])),
    );
    const key = storeKeyFromDigest(digest);

    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath: join(project, key),
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: shared },
    });

    expect(result.shared).toBe(true);
    expect(
      (await readdir(join(project, key, 'package', 'lib'))).sort(),
    ).toEqual([...names].sort());
  });

  it('is published once when several projects install the same new package at the same time', async () => {
    const shared = await tempDir('opm-shared-');
    const { bytes, digest } = archive({ 'big.bin': randomBytes(256 * 1024) });
    const key = storeKeyFromDigest(digest);
    const projects = await Promise.all(
      Array.from({ length: 6 }, () => tempDir('opm-proj-')),
    );

    const results = await Promise.all(
      projects.map((project) =>
        materializeThroughSharedStore({
          digest,
          projectStorePath: join(project, key),
          bytes,
          format: 'tar+gzip',
          env: { OPM_STORE_HOME: shared },
        }),
      ),
    );

    expect(results.every((result) => result.shared)).toBe(true);
    expect((await readdir(shared)).sort()).toEqual([key, `${key}.tree`].sort());
    expect((await stat(join(shared, key, 'package', 'big.bin'))).nlink).toBe(7);
  });

  it('names the entry to remove when it no longer matches its recorded digest', async () => {
    const shared = await tempDir('opm-shared-');
    const { bytes, digest } = archive();
    const key = storeKeyFromDigest(digest);
    const env = { OPM_STORE_HOME: shared };
    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(await tempDir('opm-proj-'), key),
      bytes,
      format: 'tar+gzip',
      env,
    });
    const victim = join(shared, key, 'package', 'index.js');
    await chmod(victim, 0o644);
    await writeFile(victim, 'edited in place\n');

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: join(await tempDir('opm-proj-'), key),
        bytes,
        format: 'tar+gzip',
        env,
      }),
    ).rejects.toThrow(new RegExp(`remove ${join(shared, key)}`, 'u'));
  });

  it('is published again, not failed, when something that ignores claims removes it between publishing and linking', async () => {
    const shared = await tempDir('opm-shared-');
    const { bytes, digest } = archive();
    const key = storeKeyFromDigest(digest);
    const env = { OPM_STORE_HOME: shared };
    const earlier = await tempDir('opm-proj-');
    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(earlier, key),
      bytes,
      format: 'tar+gzip',
      env,
    });
    await rm(earlier, { recursive: true });
    // Nothing links to it now. `opm gc --shared` leaves it while this install
    // claims it (see shared-store.gc-race.test.ts); a remover that does not
    // honour claims (an older opm, a person) may still take it.
    let collected = false;
    let fetches = 0;
    const project = await tempDir('opm-proj-');

    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath: join(project, key),
      bytes: async () => {
        fetches += 1;
        return bytes;
      },
      format: 'tar+gzip',
      env,
      linkFile: async (existing, target) => {
        if (!collected) {
          collected = true;
          await rm(join(shared, key), { recursive: true, force: true });
        }
        const { link } = await import('node:fs/promises');
        await link(existing, target);
      },
    });

    expect(result.shared).toBe(true);
    expect(fetches).toBe(1);
    expect(
      await readFile(join(project, key, 'package', 'index.js'), 'utf8'),
    ).toBe('module.exports = 1;\n');
  });
});

describe('no second copy of a package', () => {
  async function lockFor(
    bytes: Uint8Array,
    sourcePath: string,
  ): Promise<ReturnType<typeof lockPackageFromSource>> {
    await writeFile(sourcePath, bytes);
    return lockPackageFromSource({
      alias: 'demo',
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      ecosystem: 'npm',
      bytes,
      source: `file:${sourcePath}`,
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
    });
  }

  async function withStoreHome<T>(
    value: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = process.env.OPM_STORE_HOME;
    if (value === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = value;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = previous;
    }
  }

  it('writes no tarball into the project store or the shared root', async () => {
    const shared = await tempDir('opm-shared-');
    const root = await tempDir('opm-proj-');
    await initProject({ root, name: 'one' });
    const { bytes } = archive();
    const pkg = await lockFor(bytes, join(await tempDir('opm-src-'), 'd.tgz'));

    const installed = await withStoreHome(shared, () =>
      materializeLockPackage({ root, pkg, offline: true }),
    );

    expect(installed.cached).toBe(false);
    await expect(
      lstat(`${installed.storePath}.artifact`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(shared)).filter((name) => name.endsWith('.artifact')),
    ).toEqual([]);
  });

  it('keeps the tarball for repair when there is no shared store', async () => {
    const root = await tempDir('opm-proj-');
    await initProject({ root, name: 'local' });
    const { bytes } = archive();
    const pkg = await lockFor(bytes, join(await tempDir('opm-src-'), 'd.tgz'));

    const installed = await withStoreHome('off', () =>
      materializeLockPackage({ root, pkg, offline: true }),
    );

    expect((await lstat(`${installed.storePath}.artifact`)).isFile()).toBe(
      true,
    );
  });

  it('reports a package served from the shared store as cached, without moving bytes', async () => {
    const shared = await tempDir('opm-shared-');
    const { bytes, digest } = archive();
    const source = join(await tempDir('opm-src-'), 'd.tgz');
    const first = await tempDir('opm-proj-a-');
    const second = await tempDir('opm-proj-b-');
    await initProject({ root: first, name: 'a' });
    await initProject({ root: second, name: 'b' });
    const pkg = await lockFor(bytes, source);
    await withStoreHome(shared, () =>
      materializeLockPackage({ root: first, pkg, offline: true }),
    );
    await rm(source);
    // A lock read back from disk: facts from a fresh resolve, no bytes.
    const reread = {
      alias: 'demo',
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.npm.package+gzip',
      source: `file:${source}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [] as const,
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindVerifiedArtifactCacheEntry(
      reread,
      captureFactsFromSourceUri(reread.purl, reread.source, {
        evaluationTime: new Date().toISOString(),
        dependencyDepth: 0,
      }),
    );
    sealVerifiedArtifactBinding(reread);

    const installed = await withStoreHome(shared, () =>
      materializeLockPackage({ root: second, pkg: reread, offline: true }),
    );

    expect(installed.cached).toBe(true);
    await expect(
      lstat(`${installed.storePath}.artifact`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('opm gc --shared', () => {
  async function install(shared: string, key: string, bytes: Uint8Array) {
    const project = await tempDir('opm-proj-');
    await materializeThroughSharedStore({
      digest: `sha256:${key.slice('sha256-'.length)}`,
      projectStorePath: join(project, key),
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: shared },
    });
    return project;
  }

  it('removes an entry no project links to and keeps one that is still in use', async () => {
    const shared = await tempDir('opm-shared-');
    const used = archive({ 'a.js': 'a\n' });
    const unused = archive({ 'b.js': 'b\n' });
    const usedKey = storeKeyFromDigest(used.digest);
    const unusedKey = storeKeyFromDigest(unused.digest);
    await install(shared, usedKey, used.bytes);
    const gone = await install(shared, unusedKey, unused.bytes);
    await rm(gone, { recursive: true });
    const env = { OPM_STORE_HOME: shared };

    const dry = await collectSharedStore({
      env,
      dryRun: true,
      minimumAgeMs: 0,
    });
    expect(dry.removed).toEqual([join(shared, unusedKey)]);
    expect(await readdir(shared)).toContain(unusedKey);

    const result = await collectSharedStore({ env, minimumAgeMs: 0 });

    expect(result).toMatchObject({ root: shared, referenced: 1, tooNew: 0 });
    expect(result.removed).toEqual([join(shared, unusedKey)]);
    expect((await readdir(shared)).sort()).toEqual(
      [usedKey, `${usedKey}.tree`].sort(),
    );
  });

  it('keeps an entry as soon as any one of its files has another name', async () => {
    const shared = await tempDir('opm-shared-');
    const pkg = archive({ 'lib/deep/file.js': 'x\n' });
    const key = storeKeyFromDigest(pkg.digest);
    const project = await install(shared, key, pkg.bytes);
    // Drop every project link but one file, deep inside.
    const keep = join(project, key, 'package', 'lib', 'deep', 'file.js');
    const survivor = join(await tempDir('opm-keep-'), 'file.js');
    const { link } = await import('node:fs/promises');
    await link(keep, survivor);
    await rm(project, { recursive: true });

    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: shared },
      minimumAgeMs: 0,
    });

    expect(result.removed).toEqual([]);
    expect(result.referenced).toBe(1);
  });

  it('leaves an entry younger than the grace period alone', async () => {
    const shared = await tempDir('opm-shared-');
    const pkg = archive();
    const key = storeKeyFromDigest(pkg.digest);
    await rm(await install(shared, key, pkg.bytes), { recursive: true });

    const young = await collectSharedStore({ env: { OPM_STORE_HOME: shared } });
    expect(young).toMatchObject({ removed: [], tooNew: 1 });

    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(shared, `${key}.tree`), old, old);
    const aged = await collectSharedStore({ env: { OPM_STORE_HOME: shared } });
    expect(aged.removed).toEqual([join(shared, key)]);
  });

  it('does nothing when there is no shared store', async () => {
    expect(await collectSharedStore({ env: {} })).toEqual({
      removed: [],
      referenced: 0,
      tooNew: 0,
      held: 0,
    });
    expect(
      await collectSharedStore({ env: { OPM_STORE_HOME: 'off' } }),
    ).toMatchObject({ removed: [] });
  });

  it('does not create the root just to look at it being empty', async () => {
    const holder = await tempDir('opm-holder-');
    const root = join(holder, 'not-yet');

    const result = await collectSharedStore({ env: { OPM_STORE_HOME: root } });

    expect(result.removed).toEqual([]);
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears what a dead install left half-written, but only once it is old', async () => {
    const shared = await tempDir('opm-shared-');
    const key = storeKeyFromDigest(archive().digest);
    const stray = join(shared, `.${key}.materialize-0000`);
    await mkdir(join(stray, 'package'), { recursive: true });
    await writeFile(join(stray, 'package', 'index.js'), 'half');
    const env = { OPM_STORE_HOME: shared };

    expect((await collectSharedStore({ env })).removed).toEqual([]);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stray, old, old);
    expect((await collectSharedStore({ env })).removed).toEqual([stray]);
    expect(await readdir(shared)).toEqual([]);
  });
});

describe('what a second project costs', () => {
  it('is links and directories only: under 5% of what the first project took', async () => {
    const { mkdtemp: make } = await import('node:fs/promises');
    const shared = await tempDir('opm-shared-');
    const closure = [
      ['big-1.0.0', { 'lib/bin.dat': randomBytes(4 * 1024 * 1024) }],
      ['text-1.0.0', { 'dist/a.js': randomBytes(150_000).toString('base64') }],
      ['small-1.0.0', { 'x.js': 'x' }],
    ] as const;
    const archives = closure.map(([id, files]) => {
      const { bytes, digest } = archive({
        ...files,
        'package.json': JSON.stringify({ name: id }),
      });
      return { id, bytes, digest };
    });
    const previous = process.env.OPM_STORE_HOME;
    process.env.OPM_STORE_HOME = shared;
    const projects: string[] = [];
    try {
      for (const name of ['first', 'second']) {
        const root = await make(join(tmpdir(), `opm-cost-${name}-`));
        temps.push(root);
        await initProject({ root, name });
        projects.push(root);
        for (const item of archives) {
          const source = join(root, `${item.id}.tgz`);
          await writeFile(source, item.bytes);
          const pkg = lockPackageFromSource({
            alias: item.id,
            purl: `pkg:npm/${item.id.split('-')[0]}@1.0.0`,
            version: '1.0.0',
            ecosystem: 'npm',
            bytes: item.bytes,
            source: `file:${source}`,
            format: 'tar+gzip',
            mediaType: 'application/vnd.npm.package+gzip',
          });
          await materializeLockPackage({ root, pkg, offline: true });
          // The tarball a test put there itself is not opm's cost.
          await rm(source);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = previous;
    }

    const first = await uniqueBytes([shared, projects[0]!]);
    const both = await uniqueBytes([shared, projects[0]!, projects[1]!]);
    const second = both - first;

    expect(first).toBeGreaterThan(4 * 1024 * 1024);
    expect(second / first).toBeLessThan(0.05);
  });
});
