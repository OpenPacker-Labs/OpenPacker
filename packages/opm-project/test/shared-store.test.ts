import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import {
  captureFactsFromSourceUri,
  collectGarbage,
  digestOf,
  initProject,
  lockPackageFromSource,
  materializeLockPackage,
  storeKeyFromDigest,
  storePathForDigest,
} from '../src/index.js';
import {
  bindVerifiedArtifactCacheEntry,
  sealVerifiedArtifactBinding,
} from '../src/install.js';
import { projectPaths, sharedStoreHome } from '../src/paths.js';
import {
  isolateProjectStoreFromSharedLinks,
  materializeThroughSharedStore,
  sharedStoreRoot,
} from '../src/shared-store.js';
import { OpmError } from '../src/types.js';

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

function fixtureArchive(): Uint8Array {
  return packTarGzip([
    {
      path: 'package/index.js',
      contents: new TextEncoder().encode('export const n = 1;\n'),
    },
    {
      path: 'package/package.json',
      contents: new TextEncoder().encode(
        JSON.stringify({ name: 'demo-cas', version: '1.0.0' }),
      ),
    },
  ]);
}

function archiveDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('sharedStoreRoot / sharedStoreHome', () => {
  it('re-exports the frozen API from the package entry', async () => {
    const api = await import('../src/index.js');
    expect(typeof api.sharedStoreRoot).toBe('function');
    expect(typeof api.materializeThroughSharedStore).toBe('function');
  });

  it('is off when OPM_STORE_HOME is unset or blank', () => {
    expect(sharedStoreRoot({})).toBeUndefined();
    expect(sharedStoreRoot({ OPM_STORE_HOME: '' })).toBeUndefined();
    expect(sharedStoreRoot({ OPM_STORE_HOME: '   ' })).toBeUndefined();
    expect(sharedStoreHome({})).toBeUndefined();
  });

  it('returns the absolute env path when set', async () => {
    const home = await tempDir('opm-store-home-');
    expect(sharedStoreRoot({ OPM_STORE_HOME: home })).toBe(home);
    expect(sharedStoreHome({ OPM_STORE_HOME: `${home}/` })).toBe(`${home}/`);
  });

  it('refuses a relative OPM_STORE_HOME', () => {
    expect(() => sharedStoreRoot({ OPM_STORE_HOME: 'relative/store' })).toThrow(
      OpmError,
    );
    try {
      sharedStoreRoot({ OPM_STORE_HOME: 'relative/store' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });
});

describe('materializeThroughSharedStore', () => {
  it('materializes only into the project store when the feature is off', async () => {
    const root = await tempDir('opm-proj-store-');
    const projectStorePath = join(root, 'sha256-off');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    let fetches = 0;

    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath,
      bytes: async () => {
        fetches += 1;
        return bytes;
      },
      format: 'tar+gzip',
      env: {},
    });

    expect(result).toEqual({ path: projectStorePath, shared: false });
    expect(fetches).toBe(1);
    expect(
      await readFile(join(projectStorePath, 'package/index.js'), 'utf8'),
    ).toContain('export const n = 1');
    const names = await (await import('node:fs/promises')).readdir(root);
    expect(names).toEqual(['sha256-off']);
  });

  it('writes a shared sha256-* tree and hardlinks it into the project store', async () => {
    const sharedHome = await tempDir('opm-shared-cas-');
    const projectRoot = await tempDir('opm-proj-cas-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));
    let fetches = 0;

    const first = await materializeThroughSharedStore({
      digest,
      projectStorePath,
      bytes: async () => {
        fetches += 1;
        return bytes;
      },
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });

    expect(first.shared).toBe(true);
    expect(first.path).toBe(projectStorePath);
    expect(first.path.startsWith(sharedHome)).toBe(false);

    const sharedEntry = join(sharedHome, storeKeyFromDigest(digest));
    expect(
      await readFile(join(sharedEntry, 'package/index.js'), 'utf8'),
    ).toContain('export const n = 1');
    expect(
      await readFile(join(projectStorePath, 'package/index.js'), 'utf8'),
    ).toContain('export const n = 1');

    const sharedStat = await stat(join(sharedEntry, 'package/index.js'));
    const projectStat = await stat(join(projectStorePath, 'package/index.js'));
    expect(sharedStat.ino).toBe(projectStat.ino);
    expect(projectStat.nlink).toBeGreaterThanOrEqual(2);

    const secondRoot = await tempDir('opm-proj-cas2-');
    const secondPath = join(secondRoot, storeKeyFromDigest(digest));
    const second = await materializeThroughSharedStore({
      digest,
      projectStorePath: secondPath,
      bytes: async () => {
        fetches += 1;
        return bytes;
      },
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });

    expect(second.shared).toBe(true);
    expect(fetches).toBe(1);
    expect(
      await readFile(join(secondPath, 'package/index.js'), 'utf8'),
    ).toContain('export const n = 1');
  });

  it('breaks hardlinks so later writes do not mutate the shared tree', async () => {
    const sharedHome = await tempDir('opm-shared-isolate-');
    const projectRoot = await tempDir('opm-proj-isolate-');
    const otherRoot = await tempDir('opm-proj-isolate-other-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));
    const otherPath = join(otherRoot, storeKeyFromDigest(digest));

    await materializeThroughSharedStore({
      digest,
      projectStorePath,
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });
    await materializeThroughSharedStore({
      digest,
      projectStorePath: otherPath,
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });

    await isolateProjectStoreFromSharedLinks(projectStorePath);
    const mutated = join(projectStorePath, 'package/index.js');
    await writeFile(mutated, 'mutated-by-lifecycle\n');
    expect(
      await readFile(
        join(sharedHome, storeKeyFromDigest(digest), 'package/index.js'),
        'utf8',
      ),
    ).toContain('export const n = 1');
    expect(
      await readFile(join(otherPath, 'package/index.js'), 'utf8'),
    ).toContain('export const n = 1');
    expect(await readFile(mutated, 'utf8')).toBe('mutated-by-lifecycle\n');
  });

  it('copies on EXDEV from an injectable link function', async () => {
    const sharedHome = await tempDir('opm-shared-exdev-');
    const projectRoot = await tempDir('opm-proj-exdev-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));
    let linkAttempts = 0;

    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath,
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
      linkFile: async () => {
        linkAttempts += 1;
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const error = new Error('cross-device link') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      },
    });

    expect(result.shared).toBe(true);
    expect(linkAttempts).toBeGreaterThan(0);
    const sharedFile = join(
      sharedHome,
      storeKeyFromDigest(digest),
      'package/index.js',
    );
    const projectFile = join(projectStorePath, 'package/index.js');
    expect(await readFile(projectFile, 'utf8')).toEqual(
      await readFile(sharedFile, 'utf8'),
    );
    const sharedStat = await stat(sharedFile);
    const projectStat = await stat(projectFile);
    expect(projectStat.ino).not.toBe(sharedStat.ino);
    expect(projectStat.nlink).toBe(1);
  });

  it('refuses bytes that do not match the claimed digest', async () => {
    const sharedHome = await tempDir('opm-shared-mismatch-');
    const projectRoot = await tempDir('opm-proj-mismatch-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));
    const other = new Uint8Array(bytes);
    other[0] ^= 0xff;

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath,
        bytes: other,
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });

    await expect(
      stat(join(sharedHome, storeKeyFromDigest(digest))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a digest mismatch in an existing shared tree', async () => {
    const sharedHome = await tempDir('opm-shared-tamper-');
    const projectRoot = await tempDir('opm-proj-tamper-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));

    await materializeThroughSharedStore({
      digest,
      projectStorePath,
      bytes,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });

    await writeFile(
      join(sharedHome, storeKeyFromDigest(digest), 'package/index.js'),
      'tampered\n',
    );

    const retryPath = join(
      await tempDir('opm-proj-tamper2-'),
      storeKeyFromDigest(digest),
    );
    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: retryPath,
        bytes: async () => {
          throw new Error('must not fetch after a corrupt shared entry');
        },
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  });

  it('does not let project GC delete the shared tree', async () => {
    const sharedHome = await tempDir('opm-shared-gc-');
    const project = await tempDir('opm-proj-gc-');
    await initProject({ root: project, name: 'gc-cas' });
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const previous = process.env.OPM_STORE_HOME;
    process.env.OPM_STORE_HOME = sharedHome;
    try {
      const pkg = lockPackageFromSource({
        alias: 'demo-cas',
        purl: 'pkg:npm/demo-cas@1.0.0',
        version: '1.0.0',
        ecosystem: 'npm',
        bytes,
        source: 'file:demo-cas.tgz',
        format: 'tar+gzip',
        mediaType: 'application/vnd.npm.package+gzip',
      });
      const installed = await materializeLockPackage({
        root: project,
        pkg,
        offline: true,
      });
      expect(installed.storePath).toBe(storePathForDigest(project, digest));
      expect(installed.storePath.startsWith(sharedHome)).toBe(false);
      expect(projectPaths(project).store.startsWith(sharedHome)).toBe(false);

      const sharedEntry = join(sharedHome, storeKeyFromDigest(digest));
      expect(
        await readFile(join(sharedEntry, 'package/index.js'), 'utf8'),
      ).toContain('export const n = 1');

      await collectGarbage({ root: project, keep: 1 });
      await rm(installed.storePath, { recursive: true, force: true });
      expect(
        await readFile(join(sharedEntry, 'package/index.js'), 'utf8'),
      ).toContain('export const n = 1');
    } finally {
      if (previous === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = previous;
    }
  });

  it('installs a second project from shared after the source file is gone', async () => {
    const sharedHome = await tempDir('opm-shared-reuse-');
    const sourceDir = await tempDir('opm-src-reuse-');
    const source = join(sourceDir, 'demo-cas.tgz');
    const bytes = fixtureArchive();
    await writeFile(source, bytes);
    const digest = digestOf(bytes);

    const first = await tempDir('opm-proj-reuse-a-');
    const second = await tempDir('opm-proj-reuse-b-');
    await initProject({ root: first, name: 'reuse-a' });
    await initProject({ root: second, name: 'reuse-b' });

    const previous = process.env.OPM_STORE_HOME;
    process.env.OPM_STORE_HOME = sharedHome;
    try {
      const pkgA = lockPackageFromSource({
        alias: 'demo-cas',
        purl: 'pkg:npm/demo-cas@1.0.0',
        version: '1.0.0',
        ecosystem: 'npm',
        bytes,
        source: `file:${source}`,
        format: 'tar+gzip',
        mediaType: 'application/vnd.npm.package+gzip',
      });
      await materializeLockPackage({ root: first, pkg: pkgA, offline: true });
      await rm(source);

      const pkgB = {
        alias: 'demo-cas',
        purl: 'pkg:npm/demo-cas@1.0.0',
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
        pkgB,
        captureFactsFromSourceUri(pkgB.purl, pkgB.source, {
          evaluationTime: new Date().toISOString(),
          dependencyDepth: 0,
        }),
      );
      sealVerifiedArtifactBinding(pkgB);
      const installed = await materializeLockPackage({
        root: second,
        pkg: pkgB,
        offline: true,
      });
      expect(installed.storePath).toBe(storePathForDigest(second, digest));
      expect(
        await readFile(join(installed.storePath, 'package/index.js'), 'utf8'),
      ).toContain('export const n = 1');
    } finally {
      if (previous === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = previous;
    }
  });
});
