import { readdir, readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * An LF and a CRLF checkout of one patch (ADR 0057 §10). The lock records one
 * hash for both, pnpm's, of the text with CRLF made LF; the bytes applied are
 * the file's own, so a CRLF patch inserts lines that end in `\r`, as with
 * pnpm. The two are two packages, and two store entries: the entry is named by
 * the bytes applied, so a project's install never depends on which project
 * published first.
 */

const LF = [
  'diff --git a/lib.js b/lib.js',
  '--- a/lib.js',
  '+++ b/lib.js',
  '@@ -1 +1 @@',
  "-module.exports = 'original';",
  "+module.exports = 'patched';",
  '',
].join('\n');
const CRLF = LF.split('\n').join('\r\n');
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

async function patched(patch: string, store?: string): Promise<PnpmWorld> {
  const hash = sha256(patch.split('\r\n').join('\n'));
  const suffix = `(patch_hash=${hash})`;
  const w = await pnpmWorld();
  w.pkg({
    name: 'x',
    version: '1.0.0',
    suffix,
    files: { 'lib.js': "module.exports = 'original';\n" },
  });
  w.importer(
    '.',
    { dependencies: { x: ['1.0.0', `1.0.0${suffix}`] } },
    { pnpm: { patchedDependencies: { 'x@1.0.0': 'patches/x.patch' } } },
  );
  w.rootLines(
    'patchedDependencies:',
    '  x@1.0.0:',
    `    hash: ${hash}`,
    '    path: patches/x.patch',
    '',
  );
  await w.write();
  await mkdir(join(w.dir, 'patches'));
  await writeFile(join(w.dir, 'patches', 'x.patch'), patch);
  if (store !== undefined) {
    const install = w.install.bind(w);
    w.install = (extra = {}) =>
      install({ env: { OPM_STORE_HOME: store }, ...extra });
  }
  return w;
}

const storeOf = (w: PnpmWorld) => join(w.dir, '..', `${basename(w.dir)}-store`);
const lib = (w: PnpmWorld) =>
  readFile(join(w.dir, 'node_modules/x/lib.js'), 'utf8');
const patchedEntries = async (store: string) =>
  (await readdir(store))
    .filter((name) => name.includes('-patch-') && !name.includes('.'))
    .map((name) => name.slice(name.indexOf('-patch-') + '-patch-'.length))
    .sort();

describe('an LF and a CRLF checkout of one patch', () => {
  it.runIf(onPosix)(
    'install the bytes each applies, as two entries of one shared store',
    async () => {
      const a = await patched(LF);
      await a.install();
      const b = await patched(CRLF, storeOf(a));
      await b.install();
      expect(await lib(a)).toBe("module.exports = 'patched';\n");
      expect(await lib(b)).toBe("module.exports = 'patched';\r\n");
      expect(await patchedEntries(storeOf(a))).toEqual(
        [sha256(LF), sha256(CRLF)].sort(),
      );
    },
  );

  it.runIf(onPosix)(
    'never leave the store unusable when they are installed at once, twelve rounds',
    async () => {
      const failures: string[] = [];
      for (let round = 0; round < 12; round += 1) {
        const a = await patched(LF);
        const b = await patched(CRLF, storeOf(a));
        for (const result of await Promise.allSettled([
          a.install(),
          b.install(),
        ]))
          if (result.status === 'rejected')
            failures.push(`round ${round}: ${String(result.reason)}`);
        const again = await patched(LF, storeOf(a));
        await again
          .install()
          .catch((error: unknown) =>
            failures.push(`round ${round}, again: ${String(error)}`),
          );
        if (failures.length === 0) {
          expect(await lib(a)).toBe("module.exports = 'patched';\n");
          expect(await lib(b)).toBe("module.exports = 'patched';\r\n");
        }
      }
      expect(failures).toEqual([]);
    },
    120_000,
  );
});
