/**
 * What the host reads from a pnpm package's archive, which the lock does not
 * describe: whether it declares an install script (counted once per package,
 * however many places it has), and whether it is the package the lock names.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';

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
});
