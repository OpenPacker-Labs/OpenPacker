import { readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { recoverInterruptedSteps } from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
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
 * Layouts a project may be reached by that are not the plain one: through a
 * symlink to its directory, and with a path in a record that tries to write to
 * a terminal. (Layouts that need a mount are in rollback-mounts.test.ts.)
 */

describe.runIf(process.platform !== 'win32')(
  'a project reached through a symlink to its directory',
  () => {
    it('keeps its copy under the real directory and names the real path', async () => {
      const root = await project(['base']);
      const link = temporary(`${root}-link`);
      await symlink(root, link);
      const kept = await snapshotProject(link);
      const [name] = await copies(root);
      const record = JSON.parse(
        await readFile(join(root, '.opm', name!, 'rollback.json'), 'utf8'),
      ) as { project: { path: string } };
      expect(record.project.path).toBe(await realpath(root));
      await kept.discard();
    });

    it.each([
      ['made through the link, recovered through the directory', true],
      ['made through the directory, recovered through the link', false],
    ])('%s', async (_what, madeViaLink) => {
      const root = await project(['base']);
      const before = await snapshot(root);
      const link = temporary(`${root}-link`);
      await symlink(root, link);
      await snapshotProject(madeViaLink ? link : root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      const [name] = await copies(root);
      const pid = await exitedPid();
      await editRecord(root, name!, (record) => {
        record.owner.pid = pid;
      });
      expect(await recoverInterruptedSteps(madeViaLink ? root : link)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a record that names a project with a terminal escape in its path',
  () => {
    it('is refused without writing the escape to the message', async () => {
      const root = await project(['base']);
      const name = await deadCopy(root);
      await editRecord(root, name, (record) => {
        Object.assign(record, {
          project: {
            dev: '1',
            ino: '1',
            path: '/srv/x\u001b]0;pwned\u0007\nopm: all is well',
          },
        });
      });
      const refusal = recoverInterruptedSteps(root);
      await expect(refusal).rejects.toMatchObject({ code: 'INVALID_ROLLBACK' });
      const { message } = await refusal.catch((error: Error) => error);
      // eslint-disable-next-line no-control-regex
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(message).toContain('/srv/x?]0;pwned??opm: all is well');
    });
  },
);
