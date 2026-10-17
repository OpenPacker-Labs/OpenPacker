/**
 * What the host reads from a pnpm package's archive, which the lock does not
 * describe: whether it declares an install script (counted once per package,
 * however many places it has), and whether it is the package the lock names.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';
import { sri, tarballOf } from './frozen-workspace-fixture.js';

afterEach(cleanup);

describe('the archives of a pnpm install', () => {
  it('lists a package that declares an install script once, however many places it has', async () => {
    const w = await pnpmWorld();
    w.pkg({
      name: 'builds',
      version: '1.0.0',
      manifest: { scripts: { postinstall: 'node build.js' } },
    });
    w.importer('.', { dependencies: { builds: ['^1.0.0', '1.0.0'] } });
    w.importer('packages/x', { dependencies: { builds: ['^1.0.0', '1.0.0'] } });
    await w.write();
    const result = await w.install();
    expect(result.installed).toBe(2);
    expect(result.installScripts).toEqual([
      { name: 'builds', version: '1.0.0', path: 'node_modules/builds' },
    ]);
  });

  it.each([
    ['another name', { name: 'a' }, /"b@1\.0\.0".* is "a@1\.0\.0"/u],
    ['another version', { version: '9.9.9' }, /"b@1\.0\.0".* is "b@9\.9\.9"/u],
    ['no name', { name: undefined }, /"b@1\.0\.0".* has no name/u],
  ])(
    'refuses an archive whose own package.json gives %s, before node_modules is touched',
    async (_label, manifest, message) => {
      const w = await pnpmWorld();
      // The lock pins these bytes by their integrity: only their contents lie.
      w.pkg({ name: 'b', version: '1.0.0', manifest });
      w.importer('.', { dependencies: { b: ['^1.0.0', '1.0.0'] } });
      await w.write();
      await mkdir(join(w.dir, 'node_modules'), { recursive: true });
      await writeFile(join(w.dir, 'node_modules/keep.txt'), 'kept');
      const error = await w.install().then(
        () => undefined,
        (thrown: Error & { code?: string }) => thrown,
      );
      expect(error?.code).toBe('DIGEST_MISMATCH');
      expect(error?.message).toMatch(message);
      expect(await w.read('node_modules/keep.txt')).toBe('kept');
    },
  );

  it('takes a version the registry wrote with a v or build metadata as the same version', async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'c', version: '1.0.0', manifest: { version: 'v1.0.0' } });
    w.importer('.', { dependencies: { c: ['^1.0.0', '1.0.0'] } });
    await w.write();
    expect((await w.install()).installed).toBe(1);
  });

  describe('a dependency on an https: tarball', () => {
    const url = 'https://registry.npmjs.org/odd/-/odd-1.0.0.tgz';
    /**
     * A lock as pnpm writes one for `"odd": "<url>"`, the review's repro: the
     * entry's `version` is the archive's, when it has one.
     */
    const lockFor = (bytes: Uint8Array, entry: string) =>
      `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      odd:\n        specifier: ${url}\n        version: ${url}\n\npackages:\n\n  odd@${url}:\n    resolution: {integrity: ${sri(bytes)}, tarball: ${url}}\n${entry}\nsnapshots:\n\n  odd@${url}: {}\n`;
    const install = async (
      archive: { name: string; version: string },
      entry: string,
    ) => {
      const w = await pnpmWorld();
      const bytes = tarballOf({
        ...archive,
        files: { 'index.js': 'module.exports=1' },
      });
      w.registry.archives.set(url, bytes);
      w.importer('.', { dependencies: { odd: [url, url] } });
      await w.write({ lock: lockFor(bytes, entry) });
      return w.install().then(
        (result) => ({ installed: result.installed }),
        (thrown: Error & { code?: string }) => ({
          code: thrown.code,
          message: thrown.message,
        }),
      );
    };

    it('installs one whose archive has the version the lock records for it', async () => {
      expect(
        await install(
          { name: 'odd', version: '1.0.0' },
          '    version: 1.0.0\n',
        ),
      ).toEqual({ installed: 1 });
    });

    it('refuses one whose archive has another version than the lock records', async () => {
      const result = await install(
        { name: 'odd', version: '2.0.0' },
        '    version: 1.0.0\n',
      );
      expect(result).toMatchObject({ code: 'DIGEST_MISMATCH' });
      expect(String((result as { message?: string }).message)).toMatch(
        /the archive's package\.json is "odd@2\.0\.0"/u,
      );
    });

    it('refuses one whose lock writes another name beside its key', async () => {
      expect(
        await install(
          { name: 'odd', version: '1.0.0' },
          '    name: other\n    version: 1.0.0\n',
        ),
      ).toMatchObject({ code: 'DIGEST_MISMATCH' });
    });

    it('compares only the name when the lock records no version for it', async () => {
      expect(await install({ name: 'odd', version: '7.7.7' }, '')).toEqual({
        installed: 1,
      });
      expect(
        await install({ name: 'even', version: '7.7.7' }, ''),
      ).toMatchObject({ code: 'DIGEST_MISMATCH' });
    });
  });
});
