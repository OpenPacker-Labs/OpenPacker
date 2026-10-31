import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { recoverInterruptedSteps } from '../src/index.js';
import { deadCopy, project, tree } from './rollback-support.js';

configureDefaultAdapters();

/**
 * A directory comes back with the mode it had. The copy made each directory
 * with `mkdir(path, { mode })`, which the umask narrows: a 1777 volume root, a
 * group-writable `0775` and a setgid directory all came back as `0755` (found
 * by the kill sweep over a volume, round 5).
 */

const DIRECTORY_MODES = [
  ['group-writable', 0o775],
  ['world-writable', 0o777],
  ['setgid', 0o2755],
  ['sticky', 0o1777],
  ['private', 0o700],
] as const;

describe.runIf(process.platform !== 'win32')(
  'the directories of a tree put back',
  () => {
    it('have the modes they had, whatever the umask of the step that kept them', async () => {
      const previous = process.umask(0o022);
      try {
        const root = await project(['base']);
        const modules = join(root, 'node_modules');
        const generations = join(root, '.opm', 'generations');
        for (const dir of [modules, generations])
          for (const [name, mode] of DIRECTORY_MODES) {
            await mkdir(join(dir, name));
            await writeFile(join(dir, name, 'file'), 'bytes\n');
            await chmod(join(dir, name), mode);
          }
        await chmod(modules, 0o775);
        const modesOnDisk = async () => [
          ...[...(await tree(modules))].map((entry) => entry.join(' ')),
          ...[...(await tree(generations))].map((entry) => entry.join(' ')),
          `node_modules ${(await lstat(modules)).mode.toString(8)}`,
        ];
        const before = await modesOnDisk();
        expect((await lstat(join(modules, 'setgid'))).mode & 0o7777).toBe(
          0o2755,
        );
        await deadCopy(root);
        for (const dir of [modules, generations])
          for (const [name] of DIRECTORY_MODES)
            await rm(join(dir, name), { recursive: true });
        await chmod(modules, 0o755);
        await writeFile(join(modules, 'stray.js'), 'half\n');
        expect(await recoverInterruptedSteps(root)).toEqual([
          expect.objectContaining({ restored: true }),
        ]);
        expect(await modesOnDisk()).toEqual(before);
      } finally {
        process.umask(previous);
      }
    });
  },
);
