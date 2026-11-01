/**
 * The lines opm and opmx write themselves, besides the failures `handleError`
 * and `formatFailure` print: each may carry text a plugin store, a package
 * argument, a workspace or a path wrote, and each reaches the terminal plain,
 * as `out` and `report` (`@openpacker/canonical`) make it (the review of #179,
 * round 3, N-f).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from '@openpacker/sandbox';
import { processHost } from '../src/commands/run-child.js';
import { runMembers } from '../src/commands/run-members.js';
import type { WorkspacePlan } from '../src/commands/run-select.js';
import { runOpm } from '../src/opm.js';
import { runOpmx } from '../src/opmx.js';
import { capture, makeProject } from './run-fixture.js';
import { unsafeIn } from './terminal-fixture.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sandboxReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  createNativeBackend()?.id === 'native-bwrap';

/** A CSI (C1) and a right-to-left override, as a directory name may hold them. */
const HOSTILE = 'x\u009b2J\u202ey';
/** The same as `report` and `out` (`@openpacker/canonical`) write it: plain, with the controls removed. */
const PLAIN = 'x2Jy';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-terminal-'));
  temps.push(dir);
  return dir;
}

describe('what opm and opmx write themselves', () => {
  it('escapes a plugin store failure, and goes on without plugins', async () => {
    const dir = await scratch();
    const home = join(dir, HOSTILE);
    await mkdir(home);
    await writeFile(join(home, 'plugins.json'), 'not json');
    const previous = process.env.OPM_PLUGIN_HOME;
    process.env.OPM_PLUGIN_HOME = home;
    try {
      const c = capture();
      expect(await runOpm(['help'], c.io, dir)).toBe(0);
      expect(c.err).toMatch(/plugin store unavailable/u);
      expect(c.err).toContain(PLAIN);
      expect(unsafeIn(c.err)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPM_PLUGIN_HOME;
      else process.env.OPM_PLUGIN_HOME = previous;
    }
  });

  it('escapes a package opm resolve could not resolve', async () => {
    const c = capture();
    await runOpm(
      ['resolve', `pkg:zzz/${HOSTILE}@1.0.0`],
      c.io,
      await scratch(),
    );
    expect(c.err).toContain(`pkg:zzz/${PLAIN}`);
    expect(unsafeIn(c.err)).toEqual([]);
  });

  // Starting a tool needs a containment backend (bwrap on Linux); without one
  // opmx stops before it would fail this way.
  it.skipIf(!sandboxReady)(
    'escapes the error opmx reports when a tool cannot be started',
    async () => {
      const root = await scratch();
      expect(
        await runOpm(['init', '--name', 'shown'], capture().io, root),
      ).toBe(0);
      // SAFETY: the fixture catalog is this repository's own JSON.
      const catalog = JSON.parse(
        await readFile(join(repoRoot, 'fixtures/opm/catalog.json'), 'utf8'),
      ) as { packages: Record<string, { source: string }> };
      for (const entry of Object.values(catalog.packages))
        entry.source = `file:${join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz')}`;
      await writeFile(join(root, '.opm/catalog.json'), JSON.stringify(catalog));
      const added = capture();
      expect(
        await runOpm(
          ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
          added.io,
          root,
        ),
        added.err,
      ).toBe(0);
      // The jail's home goes under the temporary directory; with a file in the
      // way, starting the tool fails with an error that names that path.
      const blocked = join(root, HOSTILE);
      await writeFile(blocked, '');
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = blocked;
      try {
        const c = capture();
        expect(await runOpmx(['demo-tool'], c.io, root)).not.toBe(0);
        expect(c.err).toMatch(/^opmx: ENOTDIR/u);
        expect(c.err).toContain(PLAIN);
        expect(unsafeIn(c.err)).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    },
    30_000,
  );

  it('escapes the script name a failed opm run names', async () => {
    const root = await makeProject({
      scripts: { [HOSTILE]: 'node fail.cjs 7' },
    });
    const c = capture();
    expect(await runOpm(['run', HOSTILE], c.io, root)).toBe(7);
    expect(c.err).toBe(`opm: script "${PLAIN}" exited with code 7\n`);
  });

  it('makes plain the warnings and the failure of a workspace run', async () => {
    const member = {
      dir: 'a',
      abs: '/w/a',
      name: 'a',
      label: 'a',
      after: [],
    };
    const plan: WorkspacePlan = {
      root: '/w',
      members: [member],
      limit: 1,
      mode: 'stream',
      warnings: [`opm: warning: cyclic workspace dependencies ${HOSTILE}`],
    };
    const c = capture();
    const status = await runMembers(
      plan,
      [
        {
          member,
          runs: true,
          work: async () => ({ status: 3, failure: HOSTILE }),
        },
      ],
      c.io,
      { env: {}, platform: process.platform, host: processHost },
    );
    expect(status).toBe(3);
    expect(c.err).toBe(
      `opm: warning: cyclic workspace dependencies ${PLAIN}\nopm: ${PLAIN}\n`,
    );
  });
});

/** An OSC that sets the title, BEL, a CSI (C1) and a right-to-left override. */
const WRITTEN = 'a\u001b]0;PWN\u0007\u009b2J\u202eb';

describe('lines printed from what a registry, a lock or a package.json wrote', () => {
  it('opm run with no script: the script names and commands of package.json', async () => {
    const root = await makeProject({
      scripts: { [WRITTEN]: `echo ${WRITTEN}` },
    });
    const c = capture();
    expect(await runOpm(['run'], c.io, root)).toBe(0);
    // Made one plain line (`plainLine`): the sequences removed, the rest kept.
    expect(c.out).toBe('a2Jb\techo a2Jb\n');
    expect(unsafeIn(c.out)).toEqual([]);
  });
});
