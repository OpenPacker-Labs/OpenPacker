import { join } from 'node:path';
import { expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { VOLUME, inMounts } from './mounts-support.js';
import { describeNamespaced, mountNamespace } from './namespaces.js';

configureDefaultAdapters();

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

/**
 * A recovery killed inside the last thing it does to a volume, or inside a
 * write in place, and the recovery after it (round 5: S1, S5, N2). The first
 * kills it where the copy of a tree is removed after it was copied into a
 * volume; the second inside the write of a bind-mounted opm.toml; the third
 * puts a mount point inside the tree to be put back.
 */

describeNamespaced('a recovery on mounts, killed', mountNamespace, () => {
  it('inside the removal of the kept tree of a volume: the next recovery has the whole tree', async () => {
    const report = await inMounts(`
        for (let n = 0; n < 12; n += 1) {
          await mkdir(join(root, 'node_modules', 'pkg' + n, 'lib'), { recursive: true });
          await writeFile(join(root, 'node_modules', 'pkg' + n, 'lib', 'f.js'), 'x' + n);
        }
        ${VOLUME}
        await snapshotProject(root, { manifest: 'half-written\\n', lock: '{}\\n' });
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
        await dead();
        report.killedBy = await killedRecovery(${JSON.stringify(fixture('kill-in-rm.mjs'))});
        report.afterKill = (await listing(join(root, 'node_modules'))).join('\\n');
        report.second = await recoverInterruptedSteps(root);
        report.after = await listing(join(root, 'node_modules'));
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.after).toEqual(report.expected);
    expect(report.after?.length).toBeGreaterThan(30);
    expect(report.copies).toEqual([]);
    // Either the first recovery finished (nothing of the kept tree is removed
    // before the copy is discarded) or it was killed, and the second finished.
    expect(report.killedBy === 'SIGKILL' || report.killedBy === 0).toBe(true);
  }, 90_000);

  it('inside the write in place of a bind-mounted opm.toml: the next recovery finishes it, with its mode', async () => {
    const report = await inMounts(`
        await cp(join(root, 'opm.toml'), join(root, 'opm.src'));
        await chmod(join(root, 'opm.src'), 0o640);
        mount('--bind', join(root, 'opm.src'), join(root, 'opm.toml'));
        report.manifest = await readFile(join(root, 'opm.toml'), 'utf8');
        await snapshotProject(root, { manifest: 'half-written\\n', lock: '{}\\n' });
        await writeFile(join(root, 'opm.toml'), 'half-written\\n');
        await chmod(join(root, 'opm.toml'), 0o600);
        await dead();
        report.killedBy = await killedRecovery(${JSON.stringify(fixture('kill-in-place.mjs'))});
        report.afterKill = await readFile(join(root, 'opm.toml'), 'utf8');
        try {
          report.second = await recoverInterruptedSteps(root);
        } catch (error) {
          report.secondError = { code: error.code, message: error.message };
        }
        report.text = await readFile(join(root, 'opm.toml'), 'utf8');
        report.mode = (await stat(join(root, 'opm.toml'))).mode & 0o777;
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      `);
    expect(report.error).toBeUndefined();
    // Killed after the file was emptied and before its bytes were written.
    expect(report.killedBy).toBe('SIGKILL');
    expect(report.afterKill).toBe('');
    expect(report.secondError).toBeUndefined();
    expect(report.second).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.text).toBe(report.manifest);
    expect(report.mode).toBe(0o640);
    expect(report.copies).toEqual([]);
  }, 90_000);

  it('a mount point inside the tree to be put back is refused before anything is wiped', async () => {
    const report = await inMounts(`
        await mkdir(join(root, 'node_modules', '.cache'));
        mount('-t', 'tmpfs', 'tmpfs', join(root, 'node_modules', '.cache'));
        await writeFile(join(root, 'node_modules', '.cache', 'kept.txt'), 'cache\\n');
        report.expected = await listing(join(root, 'node_modules'));
        await snapshotProject(root, { manifest: 'half-written\\n', lock: '{}\\n' });
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
        await dead();
        report.before = await listing(join(root, 'node_modules'));
        try {
          await recoverInterruptedSteps(root);
        } catch (error) {
          report.error = { code: error.code, message: error.message };
        }
        report.after = await listing(join(root, 'node_modules'));
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
        await execFileSync('umount', [join(root, 'node_modules', '.cache')]);
        report.second = await recoverInterruptedSteps(root);
        mount('-t', 'tmpfs', 'tmpfs', join(root, 'node_modules', '.cache'));
        await writeFile(join(root, 'node_modules', '.cache', 'kept.txt'), 'cache\\n');
        report.text = (await listing(join(root, 'node_modules'))).join('\\n');
      `);
    expect(report.error).toEqual({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(
        /could not put node_modules back from \.opm\/\.rollback-.*node_modules\/\.cache is a mount point inside it.*Nothing was changed.*Unmount/su,
      ),
    });
    // Nothing was wiped: the tree is as the step left it, and the copy is kept.
    expect(report.after).toEqual(report.before);
    expect(report.before).toContain('/stray.js');
    expect(report.copies).toHaveLength(1);
    // Unmounted, the recovery finishes.
    expect(report.second).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.text).toBe(report.expected?.join('\n'));
  }, 90_000);
});
