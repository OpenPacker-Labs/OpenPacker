import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockBackend,
  MAX_INHERITED_HANDLES,
  type SandboxBackend,
} from '@openpacker/sandbox';
import { runSandboxedPackageProcess } from '../src/index.js';

/**
 * How many handles a run hands its process, counted where they are real: the
 * directories the process holds when the spawner starts it (the spawner refuses
 * a run past MAX_INHERITED_HANDLES). Each case states its number, worked out
 * from the layout, so a budget that is wrong cannot agree with itself: a run
 * one handle over the bound is refused, one under binds a store less than it
 * could.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A fresh tree: `count` entries in each named store, and the directories to run in. */
async function tree(stores: Record<string, number>) {
  const base = await mkdtemp(join(tmpdir(), 'opm-view-handles-'));
  temps.push(base);
  const dir = async (path: string) => {
    await mkdir(path, { recursive: true });
    return path;
  };
  const entries: Record<string, string[]> = {};
  for (const [name, count] of Object.entries(stores)) {
    entries[name] = [];
    for (let i = 0; i < count; i += 1) {
      const entry = await dir(
        join(base, name, `sha256-${i.toString(16).padStart(64, '0')}`),
      );
      await writeFile(join(entry, 'index.js'), `module.exports = ${i};\n`);
      entries[name]!.push(entry);
    }
  }
  return { base, entries, dir };
}

/** The directories a process holds as inherited handles, counted by itself. */
const countDirectories =
  "const fs=require('fs');let n=0;" +
  "for(const f of fs.readdirSync('/proc/self/fd')){if(Number(f)<3)continue;" +
  "try{const to=fs.readlinkSync('/proc/self/fd/'+f);" +
  "if(!to.startsWith('/proc/')&&fs.statSync('/proc/self/fd/'+f).isDirectory())n++}catch{}}" +
  'process.stdout.write(String(n))';

/** The spawner without a jail, under a name that counts as an enforcing one. */
const spawner = createMockBackend();
const backend: SandboxBackend = {
  id: 'native-bwrap',
  run: (input) => spawner.run(input),
};

const heldBy = async (run: Parameters<typeof runSandboxedPackageProcess>[0]) =>
  Number(
    (
      await runSandboxedPackageProcess({
        timeoutMs: 0,
        ...run,
        argv: [process.execPath, '-e', countDirectories],
        backend,
      })
    ).stdout,
  );

/** A policy letting the run write the project; the field is read, not typed. */
const writesProject = {
  sandboxMode: 'fail-closed',
  projectWrite: true,
} as const;

const PACKAGE = 'pkg:npm/x@1.0.0';
const grants = (read: string[], write: string[]) => ({
  sandboxPackageGrants: { 'pkg:npm/x': { read, write } },
});

describe('the handles a run hands its process', () => {
  const max = MAX_INHERITED_HANDLES;

  it('is the working directory, the jail home, and an entry each or a view', async () => {
    // cwd + jail home = 2; entries alone to 14, then one view (1).
    for (const [count, held] of [
      [1, 3],
      [13, 15],
      [14, max],
      [15, 3],
      [20, 3],
    ] as const) {
      const { entries, dir, base } = await tree({ store: count });
      const cwd = await dir(join(base, 'work'));
      expect([
        count,
        await heldBy({ argv: [], cwd, storePaths: entries.store! }),
      ]).toEqual([count, held]);
    }
  });

  it('counts the project, whether read-only or writable', async () => {
    // project (is cwd) + jail home = 2: the same 14 entries fit.
    // project + cwd (a subdirectory) + jail home = 3: 13 fit.
    for (const projectWrite of [false, true])
      for (const [inside, count, held] of [
        [false, 14, max],
        [false, 15, 3],
        [true, 13, max],
        [true, 14, 4],
      ] as const) {
        const { entries, dir, base } = await tree({ store: count });
        const projectRoot = await dir(join(base, 'project'));
        const cwd = inside ? await dir(join(projectRoot, 'src')) : projectRoot;
        const run = {
          argv: [],
          cwd,
          projectRoot,
          storePaths: entries.store!,
          ...(projectWrite && { policy: writesProject }),
        };
        expect([projectWrite, inside, count, await heldBy(run)]).toEqual([
          projectWrite,
          inside,
          count,
          held,
        ]);
      }
  });

  it('counts every path the policy grants the package', async () => {
    // cwd + jail home + two read grants + one write grant = 5: 11 entries fit.
    for (const [count, held] of [
      [11, max],
      [12, 6],
    ] as const) {
      const { entries, dir, base } = await tree({ store: count });
      const [g1, g2, g3] = [
        await dir(join(base, 'g1')),
        await dir(join(base, 'g2')),
        await dir(join(base, 'g3')),
      ];
      const run = {
        argv: [],
        cwd: await dir(join(base, 'work')),
        storePaths: entries.store!,
        packageId: PACKAGE,
        policy: grants([g1, g2], [g3]),
      };
      expect([count, await heldBy(run)]).toEqual([count, held]);
    }
  });

  it('is within the bound for two stores of ten entries and grants', async () => {
    // 5 for the cwd, the jail home and the grants; 20 entries alone is 25.
    // One view of one store: 1 + 10 + 5 = 16. A handle passed in for the view
    // that was opened a second time would make it 17, and be refused.
    const { entries, dir, base } = await tree({ one: 10, two: 10 });
    const [g1, g2, g3] = [
      await dir(join(base, 'g1')),
      await dir(join(base, 'g2')),
      await dir(join(base, 'g3')),
    ];
    const run = {
      argv: [],
      cwd: await dir(join(base, 'work')),
      storePaths: [...entries.one!, ...entries.two!],
      packageId: PACKAGE,
      policy: grants([g1, g2], [g3]),
    };
    expect(await heldBy(run)).toBe(max);
  });

  it('is within the bound when the grants leave room for views only', async () => {
    // 3 stores of 14, 14 and 14 entries and 4 grants: cwd + jail + 4 = 6, so
    // 10 handles for 42 entries: three views, 3 + 6 = 9.
    const { entries, dir, base } = await tree({ a: 14, b: 14, c: 14 });
    const granted = await Promise.all(
      [1, 2, 3, 4].map((i) => dir(join(base, `g${i}`))),
    );
    const run = {
      argv: [],
      cwd: await dir(join(base, 'work')),
      storePaths: [...entries.a!, ...entries.b!, ...entries.c!],
      packageId: PACKAGE,
      policy: grants(granted.slice(0, 2), granted.slice(2)),
    };
    expect(await heldBy(run)).toBe(9);
  });
});
