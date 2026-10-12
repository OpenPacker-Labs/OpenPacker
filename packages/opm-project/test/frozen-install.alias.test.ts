import { readFileSync, writeFileSync } from 'node:fs';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdapterRegistry } from '../src/index.js';
import type { FrozenInstallInput } from '../src/index.js';
import {
  cleanup,
  onPosix,
  setup,
  type World,
} from './frozen-workspace-fixture.js';
import { askOracle, walkInstalled } from './workspace-install-oracle.js';

afterEach(cleanup);

/**
 * `installFrozen` against npm's own arborist, for a workspace lock that holds
 * what neither the workspace install nor the closure work could have had alone:
 * aliases (`"string-width-cjs": "npm:string-width@^4"`) and several versions of
 * one name, in the project's `node_modules`, in a member's own, and inside a
 * package.
 *
 * - `string-width` is installed three times: 5.1.2 (the project's), 4.2.3 under
 *   the alias `string-width-cjs` (a member's dependency, hoisted), and 3.1.0
 *   inside `wrap`.
 * - `left-pad` is only ever installed under the alias `pad`, at 1.3.0 for one
 *   member and at 0.9.0 in the other member's own `node_modules`.
 * - `ansi-regex` 5.0.1 is installed as `ansi-cjs` for `wrap`, an alias that is
 *   not a member's.
 *
 * `fixtures/workspace-alias-oracle.json` holds, for each option set, the
 * (path, name, version, link target) arborist's `loadVirtual` plus npm's
 * omit and `--workspace` rules say `npm ci` installs; the name is the package's
 * own, the path is the alias. Replaying it needs no npm. To make it again, with
 * the npm that comes with this Node:
 *
 *   OPM_RECORD_ORACLE=1 npm run test -w @openpacker/opm-project -- test/frozen-install.alias.test.ts
 *
 * (then `npx prettier --write` the file). A diff in it is a changed decision to
 * be read, not a snapshot to be accepted.
 */
const RECORDED = new URL(
  './fixtures/workspace-alias-oracle.json',
  import.meta.url,
);

interface Case {
  label: string;
  request: Pick<FrozenInstallInput, 'omit' | 'workspace'>;
  oracle: string[];
}

const CASES: Case[] = [
  { label: 'everything', request: {}, oracle: [] },
  {
    label: '-w @fx/lib',
    request: { workspace: { select: ['@fx/lib'] } },
    oracle: ['--workspace', '@fx/lib'],
  },
  {
    label: '-w @fx/app',
    request: { workspace: { select: ['@fx/app'] } },
    oracle: ['--workspace', '@fx/app'],
  },
  {
    label: '--workspaces=false',
    request: { workspace: { ignore: true } },
    oracle: ['--no-workspaces'],
  },
];

const MEMBER_DIRS = ['packages/app', 'packages/lib'];

const CLI = "#!/usr/bin/env node\nconsole.log('padcli', process.argv[2]);\n";

/** The workspace, written and ready to install. */
async function fixture(): Promise<World> {
  const w = await setup();
  w.root.dependencies = { 'string-width': '^5.0.0' };
  const pkg = (name: string, version: string) => ({ name, version });
  const aliasOf = (name: string) => ({ name });
  w.place('node_modules/string-width', pkg('string-width', '5.1.2'));
  w.place(
    'node_modules/string-width-cjs',
    pkg('string-width', '4.2.3'),
    aliasOf('string-width'),
  );
  w.place('node_modules/shared', pkg('shared', '1.0.0'));
  w.place('packages/app/node_modules/shared', pkg('shared', '2.0.0'));
  w.place(
    'node_modules/pad',
    {
      ...pkg('left-pad', '1.3.0'),
      files: { 'cli.js': CLI },
      manifest: { bin: { padcli: 'cli.js' } },
    },
    aliasOf('left-pad'),
  );
  w.place(
    'packages/lib/node_modules/pad',
    {
      ...pkg('left-pad', '0.9.0'),
      files: { 'cli.js': CLI },
      manifest: { bin: { padcli: 'cli.js' } },
    },
    aliasOf('left-pad'),
  );
  w.place('node_modules/wrap', pkg('wrap', '1.0.0'), {
    dependencies: {
      'ansi-cjs': 'npm:ansi-regex@^5.0.1',
      'string-width': '^3.0.0',
    },
  });
  w.place(
    'node_modules/wrap/node_modules/string-width',
    pkg('string-width', '3.1.0'),
  );
  w.place(
    'node_modules/ansi-cjs',
    pkg('ansi-regex', '5.0.1'),
    aliasOf('ansi-regex'),
  );
  w.member('@fx/app', {
    dependencies: {
      'string-width-cjs': 'npm:string-width@^4.2.0',
      pad: 'npm:left-pad@^1.0.0',
      shared: '^2.0.0',
      wrap: '^1.0.0',
    },
  });
  w.member('@fx/lib', {
    dependencies: { pad: 'npm:left-pad@^0.9.0', shared: '^1.0.0' },
    bin: { fxlib: 'bin/fxlib.js' },
  });
  await w.write();
  return w;
}

const recording = process.env.OPM_RECORD_ORACLE !== undefined;

const recorded: Record<string, string[]> = recording
  ? {}
  : (JSON.parse(readFileSync(RECORDED, 'utf8')) as Record<string, string[]>);

describe('installFrozen against what npm ci installs for a workspace with aliases', () => {
  if (recording) {
    it('records what arborist says', async () => {
      const w = await fixture();
      const sets: Record<string, string[]> = {};
      for (const entry of CASES)
        sets[entry.label] = askOracle(w.dir, entry.oracle);
      writeFileSync(RECORDED, `${JSON.stringify(sets, undefined, 2)}\n`);
    });
    return;
  }

  it.each(CASES)('$label', async (entry) => {
    const w = await fixture();
    await w.install(entry.request);
    const expected = recorded[entry.label];
    expect(expected, `no recorded set for ${entry.label}`).toBeDefined();
    expect(await walkInstalled(w.dir, MEMBER_DIRS)).toEqual(expected);
  });

  it('is a workspace with an alias at three places and one name at three versions', () => {
    // The point of the fixture: if these go, the cases above stop covering
    // what the two slices only do together.
    const everything = recorded['everything'] ?? [];
    for (const line of [
      'node_modules/string-width-cjs|string-width|4.2.3|',
      'node_modules/string-width|string-width|5.1.2|',
      'node_modules/wrap/node_modules/string-width|string-width|3.1.0|',
      'node_modules/pad|left-pad|1.3.0|',
      'packages/lib/node_modules/pad|left-pad|0.9.0|',
      'node_modules/ansi-cjs|ansi-regex|5.0.1|',
    ])
      expect(everything).toContain(line);
  });

  describe('what Node finds, and what runs', () => {
    it('resolves every alias to the package behind it, from where each member sits', async () => {
      const w = await fixture();
      await w.install({});
      const find = (name: string, from: string) =>
        w.run(`console.log(require(${JSON.stringify(name)}))`, from);
      expect(find('string-width-cjs', 'packages/app')).toBe(
        'string-width@4.2.3',
      );
      expect(find('string-width', 'packages/app')).toBe('string-width@5.1.2');
      expect(find('pad', 'packages/app')).toBe('left-pad@1.3.0');
      expect(find('pad', 'packages/lib')).toBe('left-pad@0.9.0');
      expect(find('shared', 'packages/app')).toBe('shared@2.0.0');
      expect(find('shared', 'packages/lib')).toBe('shared@1.0.0');
      expect(find('ansi-cjs', 'node_modules/wrap')).toBe('ansi-regex@5.0.1');
      expect(find('string-width', 'node_modules/wrap')).toBe(
        'string-width@3.1.0',
      );
    });

    it("records each node_modules under the install names, the member's own apart from the project's", async () => {
      const w = await fixture();
      await w.install({});
      const record = async (modules: string) =>
        JSON.parse(await w.read(`${modules}/.opm-layout.json`)) as {
          packages: string[];
          bins: string[];
        };
      expect(await record('packages/lib/node_modules')).toMatchObject({
        packages: ['pad'],
        bins: ['padcli'],
      });
      expect(await record('packages/app/node_modules')).toMatchObject({
        packages: ['shared'],
        bins: [],
      });
      expect((await record('node_modules')).packages.sort()).toEqual([
        'ansi-cjs',
        'pad',
        'shared',
        'string-width',
        'string-width-cjs',
        'wrap',
      ]);
    });

    onPosix(
      'shims the executable of an aliased package in the .bin beside the directory it is in',
      async () => {
        const w = await fixture();
        await w.install({});
        expect(await w.read('packages/lib/node_modules/.bin/padcli')).toContain(
          "'/../pad/cli.js'",
        );
        const run = (bin: string) =>
          w.run(
            `console.log(require('node:child_process').execFileSync('sh', [${JSON.stringify(bin)}, 'x'], {encoding: 'utf8'}).trim())`,
          );
        expect(run('packages/lib/node_modules/.bin/padcli')).toBe('padcli x');
        expect(run('node_modules/.bin/padcli')).toBe('padcli x');
        // A shim, never a link.
        expect(await w.isLink('packages/lib/node_modules/.bin/padcli')).toBe(
          false,
        );
      },
    );
  });
});

describe('installFrozen and the names an aliased package has', () => {
  it("hands the adapter the package's own name, and the install name where it differs", async () => {
    const w = await fixture();
    const format = await requireAdapterRegistry().projectFormatFor('npm');
    const spy = vi.spyOn(Object.getPrototypeOf(format!), 'writeLayout');
    let entries: NativeLockEntry[];
    try {
      await w.install({});
      entries = spy.mock.calls[0]![1] as NativeLockEntry[];
    } finally {
      spy.mockRestore();
    }
    const at = (path: string) => entries.find((e) => e.layoutPath === path);
    expect(at('node_modules/string-width-cjs')).toMatchObject({
      name: 'string-width',
      installName: 'string-width-cjs',
      purl: 'pkg:npm/string-width',
    });
    expect(at('packages/lib/node_modules/pad')).toMatchObject({
      name: 'left-pad',
      installName: 'pad',
    });
    expect(at('node_modules/string-width')?.name).toBe('string-width');
    expect(at('node_modules/string-width')).not.toHaveProperty('installName');
  });

  it('names a case collision between two install names by the package, not by either alias', async () => {
    const w = await setup();
    const same = { name: 'string-width', version: '4.2.3' };
    w.place('node_modules/string-width-CJS', same, { name: 'string-width' });
    w.place('node_modules/string-width-cjs', same, { name: 'string-width' });
    await w.write();
    await expect(w.install({})).rejects.toMatchObject({
      code: 'INVALID_LOCK',
      message: expect.stringContaining(
        'string-width@4.2.3 would be installed as string-width-cjs, which differs only by case from string-width-CJS (string-width@4.2.3)',
      ),
    });
  });
});
