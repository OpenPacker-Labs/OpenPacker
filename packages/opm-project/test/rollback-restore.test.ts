import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { recoverInterruptedSteps } from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { MAX_FILE_BYTES } from '../src/rollback-files.js';
import { markerOf } from '../src/rollback-restore.js';
import {
  copies,
  deadCopy,
  editRecord,
  exitedPid,
  project,
  snapshot,
  temporary,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * Putting a project back from a copy: what is left behind when it is cut
 * short (N1), a tree the copy lost (N2), a file too large to read (N9), and a
 * file the copy began to write in place (X1).
 */

const restoreNames = async (root: string) =>
  (await readdir(root)).filter((name) => name.endsWith('.opm-restore'));

describe.runIf(process.platform !== 'win32')(
  'the names a putting back leaves',
  () => {
    it('are removed by the next step, though the copy was removed by hand (N1)', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      // A putting back killed after its temporary name was written.
      await writeFile(join(root, '.opm.toml.opm-restore'), 'kept bytes\n');
      await writeFile(join(root, '.package.json.opm-restore'), 'kept bytes\n');
      await mkdir(join(root, '.opm', '.rollback-gone'), { recursive: true });
      // The person removes the copy, as the refusal told them to.
      await rm(join(root, '.opm', (await copies(root))[0]!), {
        recursive: true,
      });
      await rm(join(root, '.opm', '.rollback-gone'), { recursive: true });
      expect(await restoreNames(root)).toHaveLength(2);
      expect(await recoverInterruptedSteps(root)).toEqual([]);
      expect(await restoreNames(root)).toEqual([]);
      expect((await snapshot(root)).manifest).toBe(before.manifest);
    });

    it('are removed in .opm as well', async () => {
      const root = await project(['base']);
      await writeFile(join(root, '.opm', '.project.json.opm-restore'), 'x');
      await recoverInterruptedSteps(root);
      expect(await readdir(join(root, '.opm'))).not.toContain(
        '.project.json.opm-restore',
      );
    });

    it('are removed whatever they are (a link, a directory): nothing outside is followed', async () => {
      const root = await project(['base']);
      const outside = temporary(`${root}.outside.txt`);
      await writeFile(outside, 'mine');
      await symlink(outside, join(root, '.opm.lock.json.opm-restore'));
      await mkdir(join(root, '.package-lock.json.opm-restore', 'inner'), {
        recursive: true,
      });
      await recoverInterruptedSteps(root);
      expect(await restoreNames(root)).toEqual([]);
      expect(await readFile(outside, 'utf8')).toBe('mine');
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a tree the copy lost (N2)',
  () => {
    it('is refused: it is not a tree already moved back', async () => {
      const root = await project(['base']);
      await deadCopy(root);
      const [copy] = await copies(root);
      await rm(join(root, '.opm', copy!, 'trees', '0'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'stray.js'), 'half\n');
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
        message: expect.stringMatching(
          /node_modules is missing from the copy/u,
        ),
      });
      // Nothing was put back, and nothing removed.
      expect(
        await readFile(join(root, 'node_modules', 'stray.js'), 'utf8'),
      ).toBe('half\n');
      expect(await copies(root)).toHaveLength(1);
    });

    it('is a tree already moved back when the copy says it began moving it', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      const [copy] = await copies(root);
      const holder = join(root, '.opm', copy!);
      // A putting back killed just after it renamed node_modules into place.
      await rename(
        join(holder, 'trees', '0'),
        join(root, 'node_modules.moved'),
      );
      await rm(join(root, 'node_modules'), { recursive: true });
      await rename(
        join(root, 'node_modules.moved'),
        join(root, 'node_modules'),
      );
      await (await open(markerOf(holder, 'trees', 0, 'moving'), 'w')).close();
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a file too large to read (N9)',
  () => {
    it('is not read to be kept: the step stops before anything changes', async () => {
      const root = await project(['base']);
      await writeFile(join(root, 'package.json'), '{}\n');
      await truncate(join(root, 'package.json'), MAX_FILE_BYTES + 1);
      await expect(snapshotProject(root)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
        message: expect.stringMatching(
          /package\.json is larger than the 64 MiB/u,
        ),
      });
      expect(await copies(root)).toEqual([]);
    });

    it('is not read from a copy: a planted kept file is refused whole', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      const [copy] = await copies(root);
      const kept = join(root, '.opm', copy!, 'files', '0');
      await truncate(kept, MAX_FILE_BYTES + 1);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
        message: expect.stringMatching(/opm.toml in the copy is larger than/u),
      });
      expect((await snapshot(root)).manifest).toBe('half-written\n');
      void before;
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a file the copy began to write in place (X1)',
  () => {
    it('is put back though it holds neither what it held nor what the step wrote', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await snapshotProject(root, {
        manifest: 'what the step meant to write\n',
      });
      const [copy] = await copies(root);
      const pid = await exitedPid();
      await editRecord(root, copy!, (record) => {
        record.owner.pid = pid;
      });
      // Half of the kept bytes, as an interrupted write-through leaves it.
      await writeFile(join(root, 'opm.toml'), before.manifest.slice(0, 20));
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
      });
      await (
        await open(
          markerOf(join(root, '.opm', copy!), 'files', 0, 'putting'),
          'w',
        )
      ).close();
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect((await snapshot(root)).manifest).toBe(before.manifest);
    });
  },
);
