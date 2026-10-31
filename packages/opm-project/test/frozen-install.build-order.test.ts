import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeBackend } from '@openpacker/sandbox';
import { pnpmWorld } from './frozen-pnpm-fixture.js';
import { cleanup, setup, type Pkg } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * `opm ci` runs the install scripts a project approved in dependency order
 * (ADR 0060 §7): a package's after those of every approved package it depends
 * on, whatever order the lock lists them in. Each script here reads the file
 * the scripts of the packages it needs wrote, through Node's own resolution
 * from where it is installed, and fails if one is not there yet; so a run in
 * the wrong order fails the install.
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

/** A package whose postinstall needs what each of `needs` built, then builds its own. */
function building(
  name: string,
  dependencies: readonly string[],
  needs: readonly string[] = dependencies,
): Pkg {
  return {
    name,
    version: '1.0.0',
    manifest: {
      dependencies: Object.fromEntries(dependencies.map((d) => [d, '1.0.0'])),
      scripts: { postinstall: 'node build.js' },
    },
    files: {
      'build.js': [
        "const fs = require('fs');",
        `const seen = ${JSON.stringify(needs)}.map((dep) =>`,
        "  fs.readFileSync(require.resolve(dep + '/built.txt'), 'utf8'));",
        `fs.writeFileSync('built.txt', [${JSON.stringify(name)}, ...seen].join(' '));`,
        '',
      ].join('\n'),
    },
  };
}

const approvals: [string, (names: string[]) => Record<string, unknown>][] = [
  ['Bun', (names) => ({ trustedDependencies: names })],
  ['pnpm', (names) => ({ pnpm: { onlyBuiltDependencies: names } })],
];

const lockDeps = (pkg: Pkg) => ({
  hasInstallScript: true,
  dependencies: pkg.manifest?.dependencies,
});

describe.skipIf(!jailed)(
  'installFrozen runs approved install scripts in dependency order',
  () => {
    it.each(
      approvals.flatMap(([manager, approve]) =>
        ['node_modules/b', 'node_modules/a/node_modules/b'].map(
          (place) => [manager, place, approve] as const,
        ),
      ),
    )(
      "runs b before a, which needs b's built output, though the lock lists a first (%s's declaration, b at %s)",
      async (_manager, place, approve) => {
        const w = await setup();
        delete w.root.workspaces;
        w.root.dependencies = { a: '1.0.0' };
        Object.assign(w.root, approve(['a', 'b']));
        const a = building('a', ['b']);
        const b = building('b', []);
        w.place('node_modules/a', a, lockDeps(a));
        w.place(place, b, lockDeps(b));
        await w.write();

        const result = await w.install({ target: linux });

        expect(await w.read('node_modules/a/built.txt')).toBe('a b');
        expect(result.built.map((item) => item.path)).toEqual([
          place,
          'node_modules/a',
        ]);
        expect(result.buildCycles).toBeUndefined();
      },
    );

    it.each(approvals)(
      'runs a diamond base first, then each side in lock order, then the top (%s)',
      async (_manager, approve) => {
        const w = await setup();
        delete w.root.workspaces;
        w.root.dependencies = { 'a-top': '1.0.0' };
        const all = ['a-top', 'b-left', 'c-right', 'd-base'];
        Object.assign(w.root, approve(all));
        const pkgs = [
          building('a-top', ['b-left', 'c-right']),
          building('b-left', ['d-base']),
          building('c-right', ['d-base']),
          building('d-base', []),
        ];
        for (const pkg of pkgs)
          w.place(`node_modules/${pkg.name}`, pkg, lockDeps(pkg));
        await w.write();

        const result = await w.install({ target: linux });

        expect(result.built.map((item) => item.name)).toEqual([
          'd-base',
          'b-left',
          'c-right',
          'a-top',
        ]);
        expect(await w.read('node_modules/a-top/built.txt')).toBe(
          'a-top b-left d-base c-right d-base',
        );
        expect(result.buildCycles).toBeUndefined();
      },
    );

    it('follows a dependency through a package that runs nothing', async () => {
      const w = await setup();
      delete w.root.workspaces;
      w.root.dependencies = { 'a-top': '1.0.0' };
      Object.assign(w.root, { trustedDependencies: ['a-top', 'c-base'] });
      const top = building('a-top', ['b-mid'], ['c-base']);
      const mid: Pkg = {
        name: 'b-mid',
        version: '1.0.0',
        manifest: { dependencies: { 'c-base': '1.0.0' } },
      };
      const base = building('c-base', []);
      w.place('node_modules/a-top', top, lockDeps(top));
      w.place('node_modules/b-mid', mid, {
        dependencies: mid.manifest?.dependencies,
      });
      w.place('node_modules/c-base', base, lockDeps(base));
      await w.write();

      const result = await w.install({ target: linux });

      expect(result.built.map((item) => item.name)).toEqual([
        'c-base',
        'a-top',
      ]);
    });

    it("runs a cycle in the lock's order and reports it", async () => {
      const w = await setup();
      delete w.root.workspaces;
      w.root.dependencies = { a: '1.0.0', b: '1.0.0' };
      Object.assign(w.root, { pnpm: { onlyBuiltDependencies: ['a', 'b'] } });
      const a = building('a', ['b'], []);
      const b = building('b', ['a'], []);
      w.place('node_modules/a', a, lockDeps(a));
      w.place('node_modules/b', b, lockDeps(b));
      await w.write();

      const result = await w.install({ target: linux });

      expect(result.built.map((item) => item.name)).toEqual(['a', 'b']);
      expect(
        result.buildCycles?.map((cycle) => cycle.map((item) => item.name)),
      ).toEqual([['a', 'b']]);
    });

    it.each([
      ['onlyBuiltDependencies', 'onlyBuiltDependencies:\n  - a\n  - b\n'],
      ['allowBuilds', 'allowBuilds:\n  a: true\n  b: true\n'],
    ])(
      "orders a pnpm lock's approved scripts the same way (pnpm-workspace.yaml %s)",
      async (_field, yaml) => {
        const w = await pnpmWorld();
        const a = building('a', ['b']);
        const b = building('b', []);
        w.pkg({
          name: 'a',
          version: '1.0.0',
          deps: { b: '1.0.0' },
          manifest: a.manifest!,
          files: a.files!,
        });
        w.pkg({
          name: 'b',
          version: '1.0.0',
          manifest: b.manifest!,
          files: b.files!,
        });
        w.importer('.', { dependencies: { a: ['1.0.0', '1.0.0'] } });
        await w.write({ workspaceYaml: `packages:\n  - "."\n${yaml}` });

        const result = await w.install();

        expect(
          await readFile(join(w.dir, 'node_modules/a/built.txt'), 'utf8'),
        ).toBe('a b');
        expect(result.built.map((item) => item.name)).toEqual(['b', 'a']);
      },
    );
  },
);
