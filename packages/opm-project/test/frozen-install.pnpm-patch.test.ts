import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import { cleanup, pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * `installFrozen` over a pnpm lock with `patchedDependencies` (ADR 0056): the
 * patch is applied to a copy of the archive's files, which is a store entry of
 * its own, so the project that patches `x@1.0.0` and a project on the same
 * store that installs it unpatched never share a patched or an unpatched
 * file. (In one lock a patch applies to every instance of `name@version`, as
 * pnpm's `getPatchInfo` decides by name and version, so the unpatched
 * consumer of the same version is another project.)
 */

const X_FILES = {
  'lib.js': "module.exports = 'original';\n",
  'gone.js': 'gone\n',
  'tool.sh': 'echo tool\n',
};

const PATCH = [
  'diff --git a/lib.js b/lib.js',
  '--- a/lib.js',
  '+++ b/lib.js',
  '@@ -1 +1 @@',
  "-module.exports = 'original';",
  "+module.exports = 'patched';",
  'diff --git a/added.js b/added.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/added.js',
  '@@ -0,0 +1 @@',
  "+module.exports = 'added';",
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/tool.sh b/tool.sh',
  'old mode 100644',
  'new mode 100755',
  '',
].join('\n');

const hashOf = (text: string) =>
  createHash('sha256').update(text.split('\r\n').join('\n')).digest('hex');

/** A workspace whose root and one member use `x@1.0.0`, patched, and `y@1.0.0`, not. */
async function patched(patch = PATCH): Promise<PnpmWorld> {
  const hash = hashOf(patch);
  const suffix = `(patch_hash=${hash})`;
  const w = await pnpmWorld();
  w.pkg({ name: 'x', version: '1.0.0', suffix, files: X_FILES });
  w.pkg({ name: 'y', version: '1.0.0' });
  w.importer(
    '.',
    { dependencies: { x: ['1.0.0', `1.0.0${suffix}`] } },
    { pnpm: { patchedDependencies: { 'x@1.0.0': 'patches/x@1.0.0.patch' } } },
  );
  w.importer('packages/web', {
    dependencies: {
      x: ['1.0.0', `1.0.0${suffix}`],
      y: ['1.0.0', '1.0.0'],
    },
  });
  w.rootLines(
    'patchedDependencies:',
    '  x@1.0.0:',
    `    hash: ${hash}`,
    '    path: patches/x@1.0.0.patch',
    '',
  );
  await w.write();
  await mkdir(join(w.dir, 'patches'));
  await writeFile(join(w.dir, 'patches', 'x@1.0.0.patch'), patch);
  return w;
}

/** A plain project on `store` that installs `x@1.0.0` unpatched. */
async function unpatched(store: string): Promise<PnpmWorld> {
  const w = await pnpmWorld();
  w.pkg({ name: 'x', version: '1.0.0', files: X_FILES });
  w.importer('.', { dependencies: { x: ['1.0.0', '1.0.0'] } });
  await w.write();
  const install = w.install.bind(w);
  w.install = (extra = {}) =>
    install({ env: { OPM_STORE_HOME: store }, ...extra });
  return w;
}

const storeOf = (w: PnpmWorld) => join(w.dir, '..', `${basename(w.dir)}-store`);
const entries = async (store: string) =>
  (await readdir(store)).filter((name) => /^sha256-[0-9a-f]{64}/u.test(name));
const executable = async (path: string) =>
  ((await stat(path)).mode & 0o111) !== 0;
const inode = async (path: string) => (await stat(path)).ino;

/** The mode of every file below `root`, by its path there. */
async function fileModes(root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[relative(root, path)] = (await stat(path)).mode;
    }
  return out;
}

describe('opm ci over a pnpm lock with patchedDependencies', () => {
  it.runIf(onPosix)(
    'installs the patched files for every importer, and a project on the same store its own unpatched ones',
    async () => {
      const a = await patched();
      const result = await a.install();
      expect(result.patched).toEqual({ packages: 1, patches: 1 });
      for (const from of ['', 'packages/web']) {
        expect(a.run("console.log(require('x/lib.js'))", from)).toBe('patched');
        expect(a.run("console.log(require('x/added.js'))", from)).toBe('added');
      }
      const x = join(a.dir, 'packages/web/node_modules/x');
      await expect(stat(join(x, 'gone.js'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await executable(join(x, 'tool.sh'))).toBe(true);
      expect(a.run("console.log(require('y').id)", 'packages/web')).toBe(
        'y@1.0.0',
      );

      const store = storeOf(a);
      const b = await unpatched(store);
      await b.install();
      expect(b.run("console.log(require('x/lib.js'))")).toBe('original');
      const plain = join(b.dir, 'node_modules/x');
      expect(await executable(join(plain, 'tool.sh'))).toBe(false);
      expect(await stat(join(plain, 'gone.js'))).toBeTruthy();
      // Not one file of the two is the same file.
      for (const name of ['package.json', 'index.js', 'lib.js', 'tool.sh'])
        expect(await inode(join(plain, name))).not.toBe(
          await inode(join(a.dir, 'node_modules/x', name)),
        );

      // x unpatched (shared by b), x patched, y: three entries, each recorded.
      const names = await entries(store);
      expect(names.filter((name) => name.endsWith('.tree'))).toHaveLength(3);
      const dirs = names.filter((name) => !name.includes('.'));
      expect(dirs).toHaveLength(3);
      const patchedEntry = dirs.find((name) => name.includes('-patch-'))!;
      // Named by the bytes of the patch file, the ones applied.
      const applied = createHash('sha256').update(PATCH).digest('hex');
      expect(patchedEntry).toMatch(
        new RegExp(`^sha256-[0-9a-f]{64}-patch-${applied}$`, 'u'),
      );
      // Sealed as an archive's entry is: an edit in one project's
      // node_modules/x cannot change every project's copy.
      const modes = await fileModes(join(store, patchedEntry));
      expect(Object.keys(modes)).toEqual(
        expect.arrayContaining(['package/lib.js', 'package/added.js']),
      );
      for (const [file, mode] of Object.entries(modes))
        expect([file, mode & 0o222]).toEqual([file, 0]);

      // Each entry is held while a project links it, and only then.
      const env = { OPM_STORE_HOME: store };
      const gc = () =>
        collectSharedStore({ env, minimumAgeMs: 0, now: () => Date.now() });
      expect(await gc()).toMatchObject({ removed: [], referenced: 3 });
      await rm(join(b.dir, 'node_modules'), { recursive: true });
      // No project links the unpatched entry now, and it is kept: the
      // patched copy a links was made from it, and an install checks the
      // archive before it adopts the copy.
      const afterB = await gc();
      expect(afterB.removed).toEqual([]);
      expect(afterB.referenced).toBe(3);
      // a installs again, offline: the patched entry is adopted after its
      // tree is checked, and nothing is fetched.
      await a.install({ offline: true });
      expect(a.run("console.log(require('x/lib.js'))")).toBe('patched');
      await rm(join(a.dir, 'node_modules'), { recursive: true });
      await rm(join(a.dir, 'packages/web/node_modules'), { recursive: true });
      const empty = await gc();
      expect(empty.referenced).toBe(0);
      expect(await entries(store)).toEqual([]);
    },
  );

  it.runIf(onPosix)(
    'refuses a patch that does not apply, and leaves node_modules and the store as they were',
    async () => {
      const broken = PATCH.replace(
        "-module.exports = 'original';",
        '-not there',
      );
      const w = await patched(broken);
      await mkdir(join(w.dir, 'node_modules', 'kept'), { recursive: true });
      await expect(w.install()).rejects.toMatchObject({
        code: 'PATCH_FAILED',
        message: expect.stringContaining(
          'the patch "patches/x@1.0.0.patch" (patchedDependencies "x@1.0.0") does not apply to "x@1.0.0"',
        ),
      });
      expect(await w.list('node_modules')).toEqual(['kept']);
      const left = await readdir(storeOf(w));
      expect(left.filter((name) => name.includes('-patch-'))).toEqual([]);
    },
  );

  it.runIf(onPosix)(
    'checks the archive before it is patched, and reads a script from what is installed',
    async () => {
      // The patch changes package.json's version and adds a postinstall
      // script: checked after patching, the archive would not be x@1.0.0.
      const before = JSON.stringify({
        name: 'x',
        version: '1.0.0',
        main: 'index.js',
      });
      const after = JSON.stringify({
        name: 'x',
        version: '1.0.0-patched',
        main: 'index.js',
        scripts: { postinstall: 'node lib.js' },
      });
      const edit = [
        'diff --git a/package.json b/package.json',
        '--- a/package.json',
        '+++ b/package.json',
        '@@ -1 +1 @@',
        `-${before}`,
        '\\ No newline at end of file',
        `+${after}`,
        '\\ No newline at end of file',
        '',
      ].join('\n');
      const w = await patched(edit);
      const result = await w.install();
      expect(w.run("console.log(require('x/package.json').version)")).toBe(
        '1.0.0-patched',
      );
      expect(result.installScripts).toEqual([
        { name: 'x', version: '1.0.0', path: 'node_modules/x' },
      ]);
    },
  );
});
