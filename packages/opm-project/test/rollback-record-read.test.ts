import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { recoverInterruptedSteps } from '../src/index.js';
import { readStableFile } from '../src/paths.js';
import { recoverHeldProject } from '../src/rollback-recovery.js';
import { copies, deadCopy, project } from './rollback-support.js';

configureDefaultAdapters();

/**
 * Only "there is no record" means a copy was cut short before it had one. Any
 * other failure to read it (too many open files, an I/O error, no permission)
 * says nothing about the copy, which is kept, and the step stops.
 */
describe('a record that cannot be read for a moment', () => {
  it.each(['EMFILE', 'EIO', 'EACCES'])(
    'with %s stops the step, and the copy and the project are kept',
    async (code) => {
      const root = await project(['base']);
      const name = await deadCopy(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      const failing = async (path: string): Promise<string> => {
        expect(path).toBe(join(root, '.opm', name, 'rollback.json'));
        throw Object.assign(new Error(`${code}: simulated`), { code });
      };
      await expect(recoverHeldProject(root, failing)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining(`${code}: simulated`),
      });
      expect(await copies(root)).toEqual([name]);
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
        'half-written\n',
      );
      // Once it reads, the project is put back from it.
      expect(await recoverHeldProject(root, readStableFile)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await recoverInterruptedSteps(root)).toEqual([]);
    },
  );
});
