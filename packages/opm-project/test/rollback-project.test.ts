import { cp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { recoverInterruptedSteps } from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { copyId } from '../src/rollback-recovery.js';
import {
  copies,
  deadCopy,
  editRecord,
  project,
  snapshot,
  temporary,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * A copy is put back only into the project it was made in (X3). The record
 * names the root's device and inode, which a rename keeps and a copy does not,
 * and its real path, which a project restored to the same place keeps.
 */

/** What `cp -a` makes of a project: the same files, other inodes. */
async function copyOf(root: string, name: string): Promise<string> {
  const to = temporary(`${root}-${name}`);
  await cp(root, to, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  return to;
}

describe.runIf(process.platform !== 'win32')(
  'a copy and the project it was made in',
  () => {
    it('names the project, by inode and by real path', async () => {
      const root = await project(['base']);
      await snapshotProject(root);
      const [name] = await copies(root);
      const record = JSON.parse(
        await readFile(join(root, '.opm', name!, 'rollback.json'), 'utf8'),
      ) as { project: { dev: string; ino: string; path: string } };
      expect(record.project).toEqual({
        dev: expect.stringMatching(/^\d+$/u),
        ino: expect.stringMatching(/^\d+$/u),
        path: await realpath(root),
      });
    });

    it('is put back after the project is moved on its file system (the inode stays)', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      const moved = temporary(`${root}-moved`);
      await rename(root, moved);
      expect(await recoverInterruptedSteps(moved)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect((await snapshot(moved)).manifest).toBe(before.manifest);
      expect(await copies(moved)).toEqual([]);
    });

    it('is put back into a project restored to the same place (the path stays)', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      const aside = await copyOf(root, 'aside');
      await rename(root, temporary(`${root}-gone`));
      await rename(aside, root);
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect((await snapshot(root)).manifest).toBe(before.manifest);
    });

    it('is put back when it names no project (a record an earlier opm wrote)', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      const name = await deadCopy(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      await editRecord(root, name, (record) => {
        delete (record as { project?: unknown }).project;
      });
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect((await snapshot(root)).manifest).toBe(before.manifest);
    });

    describe('copied into another project (cp -a, a cache, an archive)', () => {
      async function elsewhere() {
        const root = await project(['base']);
        const name = await deadCopy(root);
        await writeFile(join(root, 'opm.toml'), 'half-written\n');
        const other = await copyOf(root, 'copy');
        // The copy's own project carries on with its own files.
        await writeFile(join(other, 'opm.toml'), 'the other one\n');
        return { root, other, name };
      }

      it('is refused in plain words, and nothing is changed', async () => {
        const { root, other, name } = await elsewhere();
        const before = await snapshot(other);
        await expect(recoverInterruptedSteps(other)).rejects.toMatchObject({
          code: 'INVALID_ROLLBACK',
          message: expect.stringMatching(
            new RegExp(
              `made in the project at ${await realpath(root)}, and this project is at ${await realpath(other)}.*moved or restored from a backup.*never finished.*opm recover --abandon-step ${copyId(name)}.*then opm sync`,
              'u',
            ),
          ),
        });
        const { message } = await recoverInterruptedSteps(other).catch(
          (error: Error) => error,
        );
        // Nothing in it claims a replacement that did not happen.
        expect(message).not.toMatch(/would replace this project's files/u);
        expect(message).toMatch(/opm made no change/u);
        expect(await snapshot(other)).toEqual(before);
        expect(await copies(other)).toEqual([name]);
      });

      it("is refused before its owner is asked about: a live step of the other project is not this one's", async () => {
        const root = await project(['base']);
        await snapshotProject(root);
        const other = await copyOf(root, 'copy');
        await expect(recoverInterruptedSteps(other)).rejects.toMatchObject({
          code: 'INVALID_ROLLBACK',
        });
      });
    });

    it('does not matter to a copy that is only being removed (never put back anyway)', async () => {
      const root = await project(['base']);
      const name = await deadCopy(root);
      await editRecord(root, name, (record) => {
        record.state = 'copying';
      });
      const other = await copyOf(root, 'copy');
      expect(await recoverInterruptedSteps(other)).toEqual([
        expect.objectContaining({ restored: false }),
      ]);
    });
  },
);
