/**
 * One lock instance, one real path (ADR 0055 §9): a member's direct
 * dependency that the project or another member also has is written once, in
 * the project's `node_modules`, and Node loads one module for all of them.
 * Two copies were two module instances, which state held at module level
 * (react's hooks, a registry, `instanceof`) does not survive.
 *
 * What the writer then does with a shared dependency: its executable is shimmed
 * where it was written, it is left out with its importer's list, and a member
 * installed alone still finds it.
 */

import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * The common shape: an app member and a UI member that both depend on react,
 * the app linking the UI; the project has react too, and each member a tool
 * with an executable, one of them as a dev dependency.
 */
async function fixture(): Promise<PnpmWorld> {
  const w = await pnpmWorld();
  w.pkg({ name: 'react', version: '18.3.1' });
  w.pkg({
    name: 'lint',
    version: '1.0.0',
    manifest: { bin: { lint: 'index.js' } },
  });
  w.pkg({ name: 'left', version: '1.0.0' });
  w.importer('.', { dependencies: { react: ['^18.3.1', '18.3.1'] } });
  w.importer('packages/ui', {
    dependencies: { react: ['^18.3.1', '18.3.1'] },
    devDependencies: { lint: ['^1.0.0', '1.0.0'] },
  });
  w.importer('packages/web', {
    dependencies: {
      react: ['^18.3.1', '18.3.1'],
      left: ['^1.0.0', '1.0.0'],
      ui: ['workspace:*', 'link:../ui'],
    },
  });
  await w.write();
  return w;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The real path of `name` as Node resolves it from each directory. */
function realPaths(w: PnpmWorld, name: string, dirs: string[]): string[] {
  return dirs.map((dir) =>
    realpathSync(
      require.resolve(`${name}/package.json`, { paths: [join(w.dir, dir)] }),
    ),
  );
}

describe('a dependency the project and its members share', () => {
  it('is one real path, so one module, from the project and from every member', async () => {
    const w = await fixture();
    await w.install();
    const dirs = ['', 'packages/ui', 'packages/web'];
    expect(new Set(realPaths(w, 'react', dirs)).size).toBe(1);
    expect(await exists(join(w.dir, 'packages/ui/node_modules/react'))).toBe(
      false,
    );
    // web loads ui's component through the link; both get one react module.
    expect(
      w.run(
        "const path = require('path'); const ui = path.dirname(require.resolve('ui/package.json')); console.log(require('react') === require(require.resolve('react', { paths: [ui] })) && require('react') === require(require.resolve('react', { paths: ['../..'] })))",
        'packages/web',
      ),
    ).toBe('true');
  });

  onPosix(
    "shims a member's executable where its package was written, which the member's PATH reaches",
    async () => {
      const w = await fixture();
      await w.install();
      expect(await w.list('node_modules/.bin')).toContain('lint');
      expect(w.load('lint', 'packages/ui').id).toBe('lint@1.0.0');
    },
  );

  it("leaves a member's dev dependency out with --omit dev, wherever it would have gone", async () => {
    const w = await fixture();
    await w.install({ omit: ['dev'] });
    expect(await exists(join(w.dir, 'node_modules/lint'))).toBe(false);
    expect(await exists(join(w.dir, 'packages/ui/node_modules/lint'))).toBe(
      false,
    );
    expect(new Set(realPaths(w, 'react', ['', 'packages/web'])).size).toBe(1);
  });

  it('lets a member installed alone find its own dependencies', async () => {
    const w = await fixture();
    await w.install({ workspace: { filter: ['web'] } });
    expect(w.load('left/package.json', 'packages/web')).toMatchObject({
      version: '1.0.0',
    });
    expect(
      new Set(realPaths(w, 'react', ['packages/ui', 'packages/web'])).size,
    ).toBe(1);
    // The project's own list is not installed: lint is ui's dev dependency
    // and ui is installed because web links it.
    expect(await exists(join(w.dir, 'node_modules/left'))).toBe(true);
  });
});
