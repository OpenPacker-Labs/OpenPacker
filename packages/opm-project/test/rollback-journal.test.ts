import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  projectPaths,
  readManifestFile,
  recoverInterruptedSteps,
  writeManifestFile,
} from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { sha256 } from '../src/rollback-record.js';
import {
  REGISTRY_PACKAGES,
  child,
  copies,
  editRecord,
  ended,
  exitedPid,
  killingAt,
  project,
  snapshot,
  sources,
} from './rollback-support.js';

configureDefaultAdapters();

const fixture = join(import.meta.dirname, 'npm-registry-fixture.ts');
const adapters = join(
  import.meta.dirname,
  '../../adapters-default/dist/esm/index.js',
);

/**
 * package.json and package-lock.json are written late, by adapters, and are
 * the people's as much as opm's (D1). Before such a write the copy is told what
 * the file is about to hold; a copy is put back over them only while they hold
 * what it kept or one of those contents, so a hand edit or an `npm install`
 * between a kill and the next step is refused, not reverted.
 */

const MINE = '{\n  "name": "mine"\n}\n';

async function recorded(root: string): Promise<{
  files: { before: string | null; also?: string[] }[];
}> {
  const [name] = await copies(root);
  return JSON.parse(
    await readFile(join(root, '.opm', name!, 'rollback.json'), 'utf8'),
  );
}

/**
 * A project with a package.json whose step told its copy of `writes`, made
 * them, and was killed.
 */
async function killedStep(
  writes: { name: string; contents: string }[],
): Promise<string> {
  const root = await project(['base']);
  await writeFile(join(root, 'package.json'), MINE);
  const snap = await snapshotProject(root);
  for (const { name, contents } of writes) {
    await snap.noteWrite(join(root, name), contents);
    await writeFile(join(root, name), contents);
  }
  const [copy] = await copies(root);
  const pid = await exitedPid();
  await editRecord(root, copy!, (record) => {
    record.owner.pid = pid;
  });
  return root;
}

describe.runIf(process.platform !== 'win32')(
  'the writes a step tells its copy of',
  () => {
    it('are kept in the record before the file is written', async () => {
      const root = await project(['base']);
      await writeFile(join(root, 'package.json'), MINE);
      const snap = await snapshotProject(root);
      await snap.noteWrite(join(root, 'package.json'), '{"name":"theirs"}\n');
      await snap.noteWrite(join(root, 'package-lock.json'), '{"lock":1}\n');
      const { files } = await recorded(root);
      expect(files[2]?.also).toEqual([sha256('{"name":"theirs"}\n')]);
      expect(files[3]?.also).toEqual([sha256('{"lock":1}\n')]);
      // Still the old file: the copy was told first.
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(MINE);
      await snap.discard();
    });

    it('are kept once, and not when they are the file as it was', async () => {
      const root = await project(['base']);
      await writeFile(join(root, 'package.json'), MINE);
      const snap = await snapshotProject(root);
      await snap.noteWrite(join(root, 'package.json'), 'again\n');
      await snap.noteWrite(join(root, 'package.json'), 'again\n');
      await snap.noteWrite(join(root, 'package.json'), MINE);
      expect((await recorded(root)).files[2]?.also).toEqual([
        sha256('again\n'),
      ]);
      await snap.discard();
    });

    it('at once are all kept', async () => {
      const root = await project(['base']);
      await writeFile(join(root, 'package.json'), MINE);
      const snap = await snapshotProject(root);
      await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((text) =>
          snap.noteWrite(join(root, 'package.json'), text),
        ),
      );
      expect((await recorded(root)).files[2]?.also?.toSorted()).toEqual(
        ['a', 'b', 'c', 'd', 'e'].map((text) => sha256(text)).toSorted(),
      );
      await snap.discard();
    });

    it('keep only the newest 32', async () => {
      const root = await project(['base']);
      const snap = await snapshotProject(root);
      for (let n = 0; n < 40; n += 1)
        await snap.noteWrite(join(root, 'package.json'), `write ${n}\n`);
      const also = (await recorded(root)).files[2]?.also ?? [];
      expect(also).toHaveLength(32);
      expect(also.at(-1)).toBe(sha256('write 39\n'));
      expect(also).not.toContain(sha256('write 0\n'));
      await snap.discard();
    });

    it.each([
      ['opm.toml', 'opm.toml'],
      ['a file of another directory', join('sub', 'package.json')],
      ['opm state', join('.opm', 'project.json')],
    ])('say nothing about %s', async (_what, name) => {
      const root = await project(['base']);
      const snap = await snapshotProject(root);
      await snap.noteWrite(join(root, name), 'x\n');
      expect(
        (await recorded(root)).files.every((row) => row.also === undefined),
      ).toBe(true);
      await snap.discard();
    });

    it('are put back over: the files go back to what they were', async () => {
      const root = await killedStep([
        { name: 'package.json', contents: '{"name":"step"}\n' },
        { name: 'package-lock.json', contents: '{"lock":"step"}\n' },
      ]);
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(MINE);
      // It had none before the step.
      expect((await snapshot(root)).packageJson).toBe(MINE);
      await expect(
        readFile(join(root, 'package-lock.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('are put back over when the step wrote only the first of two', async () => {
      const root = await killedStep([
        { name: 'package.json', contents: '{"name":"step"}\n' },
      ]);
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(MINE);
    });

    it('are put back over when the step was killed before it wrote what it announced', async () => {
      const root = await project(['base']);
      await writeFile(join(root, 'package.json'), MINE);
      const snap = await snapshotProject(root);
      await snap.noteWrite(join(root, 'package.json'), '{"name":"step"}\n');
      const [copy] = await copies(root);
      const pid = await exitedPid();
      await editRecord(root, copy!, (record) => {
        record.owner.pid = pid;
      });
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(MINE);
    });

    it.each(['package.json', 'package-lock.json'])(
      'are not put back over a later edit of %s: refused, the file and the copy kept',
      async (name) => {
        const root = await killedStep([{ name, contents: '{"step":true}\n' }]);
        // After the kill the person edits it, or npm install does.
        await writeFile(join(root, name), '{"edited":"by hand"}\n');
        await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
          code: 'ROLLBACK_CONFLICT',
          message: expect.stringContaining(name),
        });
        expect(await readFile(join(root, name), 'utf8')).toBe(
          '{"edited":"by hand"}\n',
        );
        expect(await copies(root)).toHaveLength(1);
      },
    );

    it('are not put back over an edit of a file the step never wrote', async () => {
      const root = await killedStep([]);
      await writeFile(join(root, 'package.json'), '{"edited":"by hand"}\n');
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
        message: expect.stringContaining('package.json'),
      });
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(
        '{"edited":"by hand"}\n',
      );
    });

    it('are not put back over a package-lock.json that appeared after the kill', async () => {
      const root = await killedStep([]);
      await writeFile(join(root, 'package-lock.json'), '{"npm":"install"}\n');
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
      });
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a sync killed as it writes package.json',
  () => {
    /** A sync that adds a package to an npm project with a package.json, killed at the rename. */
    async function killedSync(): Promise<{ root: string; before: string }> {
      const root = await project(['base']);
      const paths = projectPaths(root);
      await writeFile(join(root, 'package.json'), MINE);
      const manifest = await readManifestFile(paths.manifest);
      manifest.packages.third = { alias: 'third', purl: 'pkg:npm/third' };
      await writeManifestFile(paths.manifest, manifest);
      const before = await readFile(join(root, 'package.json'), 'utf8');
      const killed = await child(
        root,
        `const { syncProject } = await import(${JSON.stringify(sources.index)});
         const { configureDefaultAdapters } = await import(${JSON.stringify(adapters)});
         configureDefaultAdapters();
         const { NpmRegistryFixture } = await import(${JSON.stringify(fixture)});
         await syncProject({ root, registryOptions: { transport: new NpmRegistryFixture(${JSON.stringify(REGISTRY_PACKAGES)}) } });`,
        [],
        killingAt(
          'rename',
          '/\\.package\\.json\\.opm-[0-9a-f-]+\\.tmp$',
          '/package\\.json$',
        ),
      );
      expect(await ended(killed)).toEqual({ code: null, signal: 'SIGKILL' });
      return { root, before };
    }

    it('told its copy what package.json was to hold, before it held it', async () => {
      const { root, before } = await killedSync();
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
      expect((await recorded(root)).files[2]?.also).toEqual([
        expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      ]);
    }, 60_000);

    it('is put back: package.json as it was', async () => {
      const { root, before } = await killedSync();
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
    }, 60_000);

    it('is not put back over a package.json edited after the kill', async () => {
      const { root } = await killedSync();
      await writeFile(join(root, 'package.json'), '{"edited":"after"}\n');
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
        message: expect.stringContaining('package.json'),
      });
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(
        '{"edited":"after"}\n',
      );
      expect(await copies(root)).toHaveLength(1);
    }, 60_000);
  },
);
