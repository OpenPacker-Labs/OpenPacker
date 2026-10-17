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
    [
      'another version',
      { version: '9.9.9' },
      /"b@1\.0\.0".* is "b@9\.9\.9", and the lock records version "1\.0\.0"/u,
    ],
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

  // pnpm's equalOrSemverEqual: the same text, or semver.eq(a, b, { loose: true }).
  it.each([
    ['1.0.0', 'v1.0.0'],
    ['1.0.0', '1.0.0+build.5'],
    ['1.0.0', ' 1.0.0 '],
    ['1.0.0', '=1.0.0'],
    ['1.0.0', 'vv1.0.0'],
    ['1.0.0', '01.0.0'],
    ['1.0.0-1', '1.0.0-01'],
  ])(
    'takes an archive that writes %j as %j, as pnpm does',
    async (locked, written) => {
      const w = await pnpmWorld();
      w.pkg({ name: 'c', version: locked, manifest: { version: written } });
      w.importer('.', { dependencies: { c: [locked, locked] } });
      await w.write();
      expect((await w.install()).installed).toBe(1);
    },
  );

  it.each([
    ['1.0.0', '1.0.1'],
    ['1.0.0-1', '1.0.0'],
    ['1.0.0', '1.0.0-1'],
  ])(
    'refuses an archive of %j that says it is %j, naming the version the lock records',
    async (locked, written) => {
      const w = await pnpmWorld();
      w.pkg({ name: 'c', version: locked, manifest: { version: written } });
      w.importer('.', { dependencies: { c: [locked, locked] } });
      await w.write();
      const error = await w.install().then(
        () => undefined,
        (thrown: Error & { code?: string }) => thrown,
      );
      expect(error?.code).toBe('DIGEST_MISMATCH');
      expect(error?.message).toContain(
        `the archive's package.json is "c@${written}", and the lock records version "${locked}"`,
      );
    },
  );

  it('takes a name in another case as the same name, as pnpm does', async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'd', version: '1.0.0', manifest: { name: 'D' } });
    w.importer('.', { dependencies: { d: ['^1.0.0', '1.0.0'] } });
    await w.write();
    expect((await w.install()).installed).toBe(1);
  });

  it('quotes what an archive says, with no character a terminal acts on', async () => {
    const w = await pnpmWorld();
    w.pkg({
      name: 'b',
      version: '1.0.0',
      manifest: { name: 'a\u009b2J\u202eb', version: '1.0.0\u2066' },
    });
    w.importer('.', { dependencies: { b: ['^1.0.0', '1.0.0'] } });
    await w.write();
    const error = await w.install().then(
      () => undefined,
      (thrown: Error & { code?: string }) => thrown,
    );
    expect(error?.code).toBe('DIGEST_MISMATCH');
    expect(error?.message).toContain('is "a\\u009b2J\\u202eb@1.0.0\\u2066"');
    expect(
      /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/u.test(error!.message),
    ).toBe(false);
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
        /the archive's package\.json is "odd@2\.0\.0", and the lock records version "1\.0\.0"/u,
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
