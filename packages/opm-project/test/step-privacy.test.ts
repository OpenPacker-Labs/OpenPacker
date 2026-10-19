import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { projectStep } from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { project, stepLocks } from './rollback-support.js';

configureDefaultAdapters();

/**
 * What a step leaves in the project says where it ran, and no more (X4): the
 * machine and the boot are digests. machine-id(5) calls the machine id
 * confidential, and a killed step leaves its lock and its record in a
 * directory that is committed, cached and shared.
 */

const read = (path: string) =>
  readFile(path, 'utf8').then(
    (text) => text.trim(),
    () => undefined,
  );

/** The ids this machine has, as the system gives them. */
const ids = (
  await Promise.all([
    read('/etc/machine-id'),
    read('/var/lib/dbus/machine-id'),
    read('/proc/sys/kernel/random/boot_id'),
  ])
).filter((id): id is string => id !== undefined && id !== '');

/** Every file under `dir`, as text. */
async function everything(dir: string, into: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await everything(path, into);
    else if (entry.isFile()) into.push(await readFile(path, 'utf8'));
  }
  return into;
}

describe.runIf(process.platform === 'linux')(
  'what a step leaves in the project',
  () => {
    it('has the ids of this machine to look for', () => {
      expect(ids.length).toBeGreaterThan(0);
    });

    it('holds neither the machine id nor the boot id in its lock', async () => {
      const root = await project([]);
      await projectStep(root, {}, async () => {
        const [name] = await stepLocks(root);
        const text = await readFile(join(root, '.opm', name!), 'utf8');
        const { owner } = JSON.parse(text) as {
          owner: { machineId?: string; bootId?: string };
        };
        for (const id of ids) expect(text).not.toContain(id);
        expect(owner.bootId).toMatch(/^d1-[0-9a-f]{32}$/u);
        if (ids.length > 1)
          expect(owner.machineId).toMatch(/^d1-[0-9a-f]{32}$/u);
      });
    });

    it('holds neither in the record of its copy, nor in any file of .opm', async () => {
      const root = await project(['base']);
      const snap = await snapshotProject(root);
      const files = await everything(join(root, '.opm'));
      expect(files.some((text) => text.includes('"rollbackVersion"'))).toBe(
        true,
      );
      for (const text of files)
        for (const id of ids) expect(text).not.toContain(id);
      await snap.discard();
    });
  },
);
