import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenInstallInput } from '../src/index.js';
import { cleanup, setup, type World } from './frozen-workspace-fixture.js';
import { walkInstalled } from './workspace-install-oracle.js';

afterEach(cleanup);

/**
 * `installFrozen` against npm's own arborist, for a workspace whose lock has
 * what the real locks at hand never had: a package inside a member, one inside
 * a package inside a member, a development and an optional dependency of a
 * member, and an optional package no platform here takes.
 *
 * `fixtures/workspace-install-oracle.json` holds, for each option set below,
 * the (path, name, version, link target) arborist's `loadVirtual` plus npm's
 * platform, optional, omit and `--workspace` rules say `npm ci` installs.
 * Replaying it needs no npm. To make it again (after changing the workspace
 * below), with the npm that comes with this Node:
 *
 *   OPM_RECORD_ORACLE=1 npm run test -w @openpacker/opm-project -- test/frozen-install.oracle.test.ts
 *
 * which asks `packages/adapter-npm/test/workspace-oracle/install-oracle.cjs`
 * (`--print-expected`) and writes the file; a diff in it is a changed
 * decision to be read, not a snapshot to be accepted.
 */
const RECORDED = new URL(
  './fixtures/workspace-install-oracle.json',
  import.meta.url,
);
const ORACLE = new URL(
  '../../adapter-npm/test/workspace-oracle/install-oracle.cjs',
  import.meta.url,
);

interface Case {
  label: string;
  request: Pick<FrozenInstallInput, 'omit' | 'workspace'>;
  /** The same options as the oracle takes them. */
  oracle: string[];
}

const CASES: Case[] = [
  { label: 'everything', request: {}, oracle: [] },
  {
    label: '--omit dev',
    request: { omit: ['dev'] },
    oracle: ['--omit', 'dev'],
  },
  {
    label: '--omit optional',
    request: { omit: ['optional'] },
    oracle: ['--omit', 'optional'],
  },
  {
    label: '--omit dev --omit optional',
    request: { omit: ['dev', 'optional'] },
    oracle: ['--omit', 'dev,optional'],
  },
  {
    label: '-w @fx/lib',
    request: { workspace: { select: ['@fx/lib'] } },
    oracle: ['--workspace', '@fx/lib'],
  },
  {
    label: '-w packages/app',
    request: { workspace: { select: ['packages/app'] } },
    oracle: ['--workspace', '@fx/app'],
  },
  {
    label: '-w @fx/lib --include-workspace-root',
    request: { workspace: { select: ['@fx/lib'], includeRoot: true } },
    oracle: ['--workspace', '@fx/lib', '--include-workspace-root'],
  },
  {
    label: '--workspaces',
    request: { workspace: { all: true } },
    oracle: ['--workspace', '@fx/app,@fx/lib'],
  },
  {
    label: '--workspaces=false',
    request: { workspace: { ignore: true } },
    oracle: ['--no-workspaces'],
  },
  {
    label: '-w @fx/app --omit dev',
    request: { omit: ['dev'], workspace: { select: ['@fx/app'] } },
    oracle: ['--omit', 'dev', '--workspace', '@fx/app'],
  },
];

const MEMBER_DIRS = ['packages/app', 'packages/lib'];

/** The workspace, written and ready to install. */
async function fixture(): Promise<World> {
  const w = await setup();
  w.root.dependencies = { shared: '^1.0.0', rootonly: '^1.0.0' };
  w.root.devDependencies = { devtool: '^1.0.0' };
  const pkg = (name: string, version: string) => ({ name, version });
  w.place('node_modules/shared', pkg('shared', '1.0.0'));
  w.place('node_modules/rootonly', pkg('rootonly', '1.0.0'));
  w.place('node_modules/leaf', pkg('leaf', '1.0.0'));
  w.place('node_modules/devtool', pkg('devtool', '1.0.0'), { dev: true });
  // `@fx/app` wants other versions than the project hoists.
  w.place('packages/app/node_modules/shared', pkg('shared', '2.0.0'));
  w.place('packages/app/node_modules/holder', pkg('holder', '1.0.0'), {
    dependencies: { shared: '^3.0.0' },
  });
  w.place(
    'packages/app/node_modules/holder/node_modules/shared',
    pkg('shared', '3.0.0'),
  );
  w.place('packages/app/node_modules/apptest', pkg('apptest', '1.0.0'), {
    dev: true,
  });
  w.place('packages/app/node_modules/aixonly', pkg('aixonly', '1.0.0'), {
    optional: true,
    os: ['aix'],
  });
  w.place(
    'packages/app/node_modules/anyplatform',
    pkg('anyplatform', '1.0.0'),
    {
      optional: true,
      os: ['!aix'],
    },
  );
  w.member('@fx/app', {
    dependencies: { shared: '^2.0.0', holder: '^1.0.0', '@fx/lib': '^1.0.0' },
    devDependencies: { apptest: '^1.0.0' },
    optionalDependencies: { aixonly: '^1.0.0', anyplatform: '^1.0.0' },
  });
  w.member('@fx/lib', {
    dependencies: { shared: '^1.0.0', leaf: '^1.0.0' },
    bin: { fxlib: 'bin/fxlib.js' },
  });
  await w.write();
  return w;
}

function ask(dir: string, oracle: readonly string[]): string[] {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(ORACLE), dir, ...oracle, '--print-expected'],
      {
        encoding: 'utf8',
      },
    ),
  ) as string[];
}

const recording = process.env.OPM_RECORD_ORACLE !== undefined;

const recorded: Record<string, string[]> = recording
  ? {}
  : (JSON.parse(readFileSync(RECORDED, 'utf8')) as Record<string, string[]>);

describe('installFrozen against what npm ci installs for a workspace', () => {
  if (recording) {
    it('records what arborist says', async () => {
      const w = await fixture();
      const sets: Record<string, string[]> = {};
      for (const entry of CASES) sets[entry.label] = ask(w.dir, entry.oracle);
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

  it('is a workspace with a package inside a package inside a member', () => {
    // The point of the fixture: if these go, the cases above stop covering
    // the placement the real locks at hand never had.
    const everything = recorded['everything'] ?? [];
    expect(everything).toContain(
      'packages/app/node_modules/shared|shared|2.0.0|',
    );
    expect(everything).toContain(
      'packages/app/node_modules/holder/node_modules/shared|shared|3.0.0|',
    );
    expect(everything).toContain(
      'packages/app/node_modules/anyplatform|anyplatform|1.0.0|',
    );
    expect(everything.some((line) => line.includes('aixonly'))).toBe(false);
  });
});
