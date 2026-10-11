/**
 * `native_projection = "layout"` end to end, from local sources only.
 *
 * An opm project whose lock holds a closure that needs two versions of one
 * package is installed, and the node_modules it leaves is loaded by a real
 * Node process. No registry is involved: the packages are tarballs written
 * here, and the dependency edges are the ones a solve records in the lock.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { packTarGzip } from '@openpacker/project-io';
import {
  digestOf,
  emptyLockfile,
  initProject,
  installFromLock,
  parseManifest,
  projectNativeFormats,
  projectPaths,
  readLockfile,
  readManifestFile,
  removePackage,
  serializeManifest,
  storeKeyFromDigest,
  writeLockfile,
  type LockPackage,
  type OpmLockfile,
} from '../src/index.js';
import { bindManifestSourceAuthority } from '../src/install.js';
import { uniqueBytes } from './disk-usage.js';

configureDefaultAdapters();

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const encode = (text: string) => new TextEncoder().encode(text);

/** An npm tarball: everything under `package/`, like the registry's. */
function tarball(
  name: string,
  version: string,
  files: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Uint8Array {
  return packTarGzip(
    Object.entries({
      'package.json': JSON.stringify({
        name,
        version,
        main: 'index.js',
        ...extra,
      }),
      'index.js': `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`,
      ...files,
    }).map(([path, contents]) => ({
      path: `package/${path}`,
      contents: encode(contents),
    })),
  );
}

const requiresC =
  "module.exports = { name: require('./package.json').name, c: require('c').version };\n";

interface Fixture {
  root: string;
  vendor: string;
  run(script: string): string;
  /** What `opm install` does after resolving: store, then native projection. */
  install(): Promise<{
    lock: Awaited<ReturnType<typeof readLockfile>> & object;
    native: Awaited<ReturnType<typeof projectNativeFormats>>;
  }>;
}

/**
 * Project `a` (needs c@1) and `b` (needs c@2) from local tarballs, with a lock
 * holding both versions of `c` and the edges that tie them to their
 * dependents, as a solve over a registry would have recorded them.
 */
async function conflictingClosure(options: {
  packageJson?: boolean;
  /** Pseudo-random bytes in c@2, so the closure has weight to measure. */
  bulk?: number;
  /** Use another fixture's tarballs: the same packages in another project. */
  vendor?: string;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'opm-layout-'));
  temps.push(root);
  await initProject({ root, name: 'layout-app' });
  const manifestPath = join(root, 'opm.toml');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  manifest.options.nativeProjection = 'layout';
  // The closure comes from tarballs on disk, not from a registry that would
  // vouch for a publish time or a source: this project says so explicitly,
  // the way an operator mirroring packages locally would. The default policy
  // is not weakened anywhere else.
  manifest.policy = {
    ...manifest.policy!,
    minimumReleaseAgeMinutes: 0,
    blockExoticSources: { transitive: false, direct: false },
  };
  await writeFile(manifestPath, serializeManifest(manifest));
  if (options.packageJson === true)
    await writeFile(
      join(root, 'package.json'),
      '{\n  "name": "layout-app",\n  "version": "0.0.0"\n}\n',
    );

  const vendor = options.vendor ?? join(root, 'vendor');
  if (options.vendor === undefined) {
    await mkdir(vendor);
    const archives = {
      a: tarball('a', '1.0.0', { 'index.js': requiresC }),
      b: tarball('b', '1.0.0', { 'index.js': requiresC }),
      c1: tarball('c', '1.0.0'),
      c2: tarball(
        'c',
        '2.0.0',
        {
          'cli.js': "#!/usr/bin/env node\nconsole.log('c2 cli');\n",
          ...(options.bulk !== undefined && {
            'data/blob.txt': randomBytes(options.bulk).toString('base64'),
          }),
        },
        { bin: { c2: 'cli.js' } },
      ),
    };
    for (const [key, bytes] of Object.entries(archives))
      await writeFile(join(vendor, `${key}.tgz`), bytes);
  }

  const paths = projectPaths(root);
  const specs = [
    ['a', 'a', '1.0.0', 'direct', ['c-1']],
    ['b', 'b', '1.0.0', 'direct', ['c-2']],
    ['c-1', 'c', '1.0.0', 'transitive', []],
    ['c-2', 'c', '2.0.0', 'transitive', []],
  ] as const;
  const archiveOf = { a: 'a', b: 'b', 'c-1': 'c1', 'c-2': 'c2' } as const;
  const lock: OpmLockfile = emptyLockfile();
  for (const [alias, name, version, reason, dependencies] of specs) {
    const path = join(vendor, `${archiveOf[alias]}.tgz`);
    const bytes = new Uint8Array(await readFile(path));
    const digest = digestOf(bytes);
    const pkg: LockPackage = {
      alias,
      purl: `pkg:npm/${name}@${version}`,
      version,
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
      source: `file:${path}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason,
      ecosystem: 'npm',
      dependencies: [...dependencies],
    };
    // The tarball is vouched for by whoever put it there, the same authority
    // a `source = "file:..."` in opm.toml carries.
    bindManifestSourceAuthority(pkg);
    lock.packages[alias] = pkg;
  }
  manifest.packages = Object.fromEntries(
    ['a', 'b'].map((alias) => [
      alias,
      {
        alias,
        purl: `pkg:npm/${alias}`,
        version: '1.0.0',
        source: `file:${join(vendor, `${alias}.tgz`)}`,
      },
    ]),
  );
  await writeFile(manifestPath, serializeManifest(manifest));
  await writeLockfile(paths.lock, lock);

  return {
    root,
    vendor,
    run: (script) =>
      execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    install: async () => {
      const current = await readManifestFile(paths.manifest);
      await installFromLock({
        root,
        lock,
        offline: true,
        ...(current.policy !== undefined && { policy: current.policy }),
      });
      return {
        lock,
        native: await projectNativeFormats({ root, manifest: current, lock }),
      };
    },
  };
}

describe('native_projection = "layout"', () => {
  it('leaves a node_modules real Node resolves for a closure that needs two versions of one package', async () => {
    const fixture = await conflictingClosure({ packageJson: false });

    const installed = await fixture.install();

    expect(Object.keys(installed.lock.packages).sort()).toEqual([
      'a',
      'b',
      'c-1',
      'c-2',
    ]);
    expect(
      fixture.run(
        "console.log(JSON.stringify([require('a').c, require('b').c, require('c').version]))",
      ),
    ).toBe('["1.0.0","2.0.0","2.0.0"]');
    // Equally wanted, so the newer c is hoisted and a keeps the older beside it.
    expect(
      JSON.parse(
        await readFile(
          join(
            fixture.root,
            'node_modules',
            'a',
            'node_modules',
            'c',
            'package.json',
          ),
          'utf8',
        ),
      ).version,
    ).toBe('1.0.0');
  });

  it('works in a project with no package.json, and does not create one', async () => {
    const fixture = await conflictingClosure({ packageJson: false });

    const installed = await fixture.install();

    expect((await readdir(fixture.root)).sort()).toEqual(
      ['.opm', 'node_modules', 'opm.lock.json', 'opm.toml', 'vendor'].sort(),
    );
    const layout = installed.native.projections.find(
      (projection) => projection.ecosystem === 'npm',
    );
    expect(layout?.semanticLoss.map((loss) => loss.code)).toContain(
      'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    );
    expect(layout?.semanticLoss[0]?.representedMeaning).toContain(
      'there is no package.json here and none was created',
    );
    expect(installed.native.unprojected).toEqual([]);
  });

  it('writes the layout beside an existing package.json and leaves that file alone', async () => {
    const fixture = await conflictingClosure({ packageJson: true });
    const before = await readFile(join(fixture.root, 'package.json'), 'utf8');

    const installed = await fixture.install();

    // These requirements are pinned to a local source, which has no native
    // coordinate to declare, so the manifest keeps saying what it said.
    expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe(
      before,
    );
    expect(
      fixture.run(
        "console.log(JSON.stringify([require('a').c, require('b').c]))",
      ),
    ).toBe('["1.0.0","2.0.0"]');
    const layout = installed.native.projections.find(
      (projection) => projection.ecosystem === 'npm',
    );
    expect(layout?.semanticLoss[0]?.representedMeaning).not.toContain(
      'none was created',
    );
  });

  it('runs a nested package executable from node_modules/.bin with no symlink', async () => {
    const fixture = await conflictingClosure({ packageJson: false });
    await fixture.install();

    // c@2 is hoisted, so its bin is in the root .bin.
    const shim = join(fixture.root, 'node_modules', '.bin', 'c2');
    expect((await lstat(shim)).isFile()).toBe(true);
    expect(execFileSync(shim, { encoding: 'utf8' }).trim()).toBe('c2 cli');
  });

  it('hard-links the node_modules files to the project store', async () => {
    const fixture = await conflictingClosure({ packageJson: false });
    await fixture.install();

    const lock = await readLockfile(projectPaths(fixture.root).lock);
    const stored = join(
      projectPaths(fixture.root).store,
      lock!.packages['c-2']!.storeKey,
      'package',
      'index.js',
    );
    const installed = join(fixture.root, 'node_modules', 'c', 'index.js');
    expect((await stat(installed)).ino).toBe((await stat(stored)).ino);
  });

  it('re-plans when a package is removed and clears what no longer belongs', async () => {
    const fixture = await conflictingClosure({ packageJson: false });
    await fixture.install();

    await removePackage({ root: fixture.root, alias: 'b', offline: true });

    // b and the c only it needed are gone, and a's c is now the root one.
    expect((await readdir(join(fixture.root, 'node_modules'))).sort()).toEqual(
      ['.bin', '.opm-layout.json', 'a', 'c'].sort(),
    );
    expect(
      fixture.run("console.log(require('a').c, require('c').version)"),
    ).toBe('1.0.0 1.0.0');
  });

  it('removing the last package leaves no layout behind', async () => {
    const fixture = await conflictingClosure({ packageJson: false });
    await fixture.install();
    await removePackage({ root: fixture.root, alias: 'b', offline: true });

    await removePackage({ root: fixture.root, alias: 'a', offline: true });

    expect(
      (await readdir(join(fixture.root, 'node_modules'))).filter(
        (name) => !name.startsWith('.'),
      ),
    ).toEqual([]);
  });

  it('writes no layout below the layout level and says the project has no npm file', async () => {
    const fixture = await conflictingClosure({ packageJson: false });
    const manifest = await readManifestFile(
      projectPaths(fixture.root).manifest,
    );
    const lock = (await readLockfile(projectPaths(fixture.root).lock))!;

    const result = await projectNativeFormats({
      root: fixture.root,
      manifest,
      lock,
      level: 'lock',
    });

    expect(result.projections).toEqual([]);
    expect(result.unprojected.map((item) => item.ecosystem)).toEqual(['npm']);
    await expect(
      lstat(join(fixture.root, 'node_modules')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('costs a second project under 5% of the first when they share the store', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'opm-layout-shared-'));
    temps.push(shared);
    const previous = process.env.OPM_STORE_HOME;
    process.env.OPM_STORE_HOME = shared;
    try {
      const first = await conflictingClosure({ bulk: 4 * 1024 * 1024 });
      await first.install();
      const second = await conflictingClosure({ vendor: first.vendor });
      await second.install();

      // Both projects are real: Node resolves the same two versions in each.
      for (const project of [first, second])
        expect(
          project.run(
            "console.log(JSON.stringify([require('a').c, require('b').c]))",
          ),
        ).toBe('["1.0.0","2.0.0"]');

      const one = await uniqueBytes([shared, first.root]);
      const both = await uniqueBytes([shared, first.root, second.root]);
      const added = both - one;
      // The second project's own opm.toml, lock and directories — and none of
      // the megabytes of package content.
      expect(one).toBeGreaterThan(4 * 1024 * 1024);
      expect(added / one).toBeLessThan(0.05);
      // And what it holds is the first project's files, not copies of them.
      const lock = (await readLockfile(projectPaths(second.root).lock))!;
      expect(
        (await stat(join(second.root, 'node_modules', 'c', 'data', 'blob.txt')))
          .ino,
      ).toBe(
        (
          await stat(
            join(
              projectPaths(first.root).store,
              lock.packages['c-2']!.storeKey,
              'package',
              'data',
              'blob.txt',
            ),
          )
        ).ino,
      );
    } finally {
      if (previous === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = previous;
    }
  });
});
