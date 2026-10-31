import { accessSync, constants } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeBackend } from '@openpacker/sandbox';
import { cleanup, setup, type Pkg } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * `opm ci` runs no install script but the ones the project approved, by name,
 * in the declarations package managers already read: pnpm's
 * `onlyBuiltDependencies` and `allowBuilds`, Bun's `trustedDependencies`.
 * An approved script runs where npm runs it, in the package's directory
 * under `node_modules`, inside the jail, with no network; the package's files
 * are its own copies first, so nothing it writes reaches the store. A link it
 * makes to a file of its own becomes a hard link to that file: `node_modules`
 * holds no symlink but a workspace member's (ADR 0048).
 */

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;

function onPath(binary: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => {
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The jail the scripts run in is Bubblewrap; without it they are refused, which other tests cover. */
const jailed =
  process.platform === 'linux' &&
  onPath('bwrap') &&
  createNativeBackend()?.id === 'native-bwrap';

/** A package whose postinstall makes a file and links a versioned library name, as embedded-postgres does. */
const hydrating = (name: string): Pkg => ({
  name,
  version: '1.0.0',
  manifest: { scripts: { postinstall: 'node scripts/post.js' } },
  files: {
    'native/lib/libpq.so.5.18': 'the library\n',
    'scripts/post.js': [
      "const fs = require('fs');",
      "fs.writeFileSync('built.txt', 'built here');",
      "fs.symlinkSync('libpq.so.5.18', 'native/lib/libpq.so.5');",
      "let reached = 'no';",
      "try { require('dns').lookup('registry.npmjs.org', (e) => { fs.writeFileSync('net.txt', e ? 'no' : 'yes'); }); } catch { fs.writeFileSync('net.txt', reached); }",
      '',
    ].join('\n'),
  },
});

async function project(approval: Record<string, unknown>) {
  const w = await setup();
  delete w.root.workspaces;
  w.root.dependencies = { approved: '1.0.0', other: '1.0.0' };
  Object.assign(w.root, approval);
  w.place('node_modules/approved', hydrating('approved'), {
    hasInstallScript: true,
  });
  w.place(
    'node_modules/other',
    {
      name: 'other',
      version: '1.0.0',
      manifest: {
        scripts: {
          postinstall:
            "node -e \"require('fs').writeFileSync('ran.txt', '1')\"",
        },
      },
    },
    { hasInstallScript: true },
  );
  await w.write();
  return w;
}

describe.skipIf(!jailed)(
  'installFrozen runs the install scripts the project approved',
  () => {
    it.each([
      ['Bun', { trustedDependencies: ['approved'] }],
      ['pnpm', { pnpm: { onlyBuiltDependencies: ['approved'] } }],
    ])(
      "runs an approved package's postinstall in place, in the jail, and no other (%s's declaration)",
      async (_manager, approval) => {
        const w = await project(approval);
        const result = await w.install({ target: linux });

        const dir = join(w.dir, 'node_modules', 'approved');
        expect(await readFile(join(dir, 'built.txt'), 'utf8')).toBe(
          'built here',
        );
        // The link the script made is a file of the package's own now.
        const linked = await lstat(join(dir, 'native/lib/libpq.so.5'));
        expect(linked.isFile()).toBe(true);
        expect(await readFile(join(dir, 'native/lib/libpq.so.5'), 'utf8')).toBe(
          'the library\n',
        );
        // No network in the jail.
        expect(
          await readFile(join(dir, 'net.txt'), 'utf8').catch(() => 'no'),
        ).toBe('no');
        // The other package's script did not run, and is reported as not run.
        expect(
          await readdir(join(w.dir, 'node_modules', 'other')),
        ).not.toContain('ran.txt');
        expect(result.built.map((item) => item.name)).toEqual(['approved']);
        expect(result.installScripts.map((item) => item.name)).toEqual([
          'other',
        ]);
        // The store's copy is the archive's: the script wrote only the project's.
        const store = `${w.dir}-store`;
        for (const entry of await readdir(store)) {
          if (!/^sha256-[0-9a-f]{64}$/u.test(entry)) continue;
          expect(await readdir(join(store, entry, 'package'))).not.toContain(
            'built.txt',
          );
        }
      },
    );
  },
);

describe('installFrozen without an approval', () => {
  it('runs no install script and says which declare one', async () => {
    const w = await project({});
    const result = await w.install({ target: linux });
    expect(
      await readdir(join(w.dir, 'node_modules', 'approved')),
    ).not.toContain('built.txt');
    expect(result.built).toEqual([]);
    expect(result.installScripts.map((item) => item.name).sort()).toEqual([
      'approved',
      'other',
    ]);
  });
});
