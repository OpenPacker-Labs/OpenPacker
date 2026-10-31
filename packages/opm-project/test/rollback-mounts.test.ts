import { expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { VOLUME, inMounts } from './mounts-support.js';
import { describeNamespaced, mountNamespace } from './namespaces.js';
import { sources } from './rollback-support.js';

configureDefaultAdapters();

/**
 * A node_modules that is a Docker volume, an opm.toml that is bind-mounted into
 * the project, a `.opm` on a volume of its own: the places a project is put
 * back into cannot always be removed or renamed over (X1). Each case runs in a
 * mount namespace of its own (`unshare`), so that nothing outlives the test.
 */

describeNamespaced('a project laid out over mounts', mountNamespace, () => {
  it('puts node_modules back when it is a volume: the directory stays, its contents come back', async () => {
    const report = await inMounts(`
        ${VOLUME}
        await snapshotProject(root);
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
        await dead();
        report.recovered = await recoverInterruptedSteps(root);
        report.tree = await listing(join(root, 'node_modules'));
        report.mounted = (await device(join(root, 'node_modules'))) !== (await device(root));
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.tree).toEqual(report.expected);
    expect(report.tree?.length).toBeGreaterThan(1);
    expect(report.mounted).toBe(true);
    expect(report.copies).toEqual([]);
  }, 60_000);

  it('gives a volume back the mode it had (a tmpfs root is 1777), and the directories in it theirs', async () => {
    const report = await inMounts(`
        ${VOLUME}
        await chmod(join(root, 'node_modules', 'base'), 0o775);
        const modes = async (dir: string, name = '.'): Promise<string[]> => {
          const out = [name + ' ' + (await lstat(dir)).mode.toString(8)];
          for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)))
            if (entry.isDirectory()) out.push(...(await modes(join(dir, entry.name), name + '/' + entry.name)));
          return out;
        };
        report.before = await modes(join(root, 'node_modules'));
        await snapshotProject(root);
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await dead();
        report.recovered = await recoverInterruptedSteps(root);
        report.after = await modes(join(root, 'node_modules'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.before?.[0]).toBe('. 41777');
    expect(report.before).toContain('./base 40775');
    expect(report.after).toEqual(report.before);
  }, 60_000);

  it('puts node_modules back when it is a volume and the step undoes itself', async () => {
    const report = await inMounts(`
        ${VOLUME}
        const kept = await snapshotProject(root);
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await kept.restore();
        report.tree = await listing(join(root, 'node_modules'));
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.tree).toEqual(report.expected);
    expect(report.copies).toEqual([]);
  }, 60_000);

  it('puts the project back when .opm is a volume of its own (the copy is on another file system)', async () => {
    const report = await inMounts(`
        await cp(join(root, '.opm'), join(root, 'opm.save'), { recursive: true, verbatimSymlinks: true });
        mount('-t', 'tmpfs', 'tmpfs', join(root, '.opm'));
        await cp(join(root, 'opm.save'), join(root, '.opm'), { recursive: true, verbatimSymlinks: true });
        await rm(join(root, 'opm.save'), { recursive: true });
        report.expected = await listing(join(root, 'node_modules'));
        await snapshotProject(root);
        await rm(join(root, 'node_modules', 'base'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
        await dead();
        report.recovered = await recoverInterruptedSteps(root);
        report.tree = await listing(join(root, 'node_modules'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.tree).toEqual(report.expected);
  }, 60_000);

  it('puts opm.toml back when it is a file bind-mounted into the project', async () => {
    const report = await inMounts(`
        await cp(join(root, 'opm.toml'), join(root, 'opm.src'));
        mount('--bind', join(root, 'opm.src'), join(root, 'opm.toml'));
        report.manifest = await readFile(join(root, 'opm.toml'), 'utf8');
        await snapshotProject(root);
        await writeFile(join(root, 'opm.toml'), 'half-written\\n');
        await dead();
        report.recovered = await recoverInterruptedSteps(root);
        report.restored = (await readFile(join(root, 'opm.toml'), 'utf8')) === report.manifest;
        report.leftovers = (await readdir(root)).filter((n) => n.endsWith('.opm-restore'));
      `);
    expect(report.error).toBeUndefined();
    expect(report.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.restored).toBe(true);
    expect(report.leftovers).toEqual([]);
  }, 60_000);

  it('says in plain words which path it could not put back and what to do, when the volume is read-only', async () => {
    const report = await inMounts(`
        ${VOLUME}
        await snapshotProject(root);
        await dead();
        mount('-o', 'remount,ro', join(root, 'node_modules'));
        try {
          await recoverInterruptedSteps(root);
        } catch (error) {
          report.error = { code: error.code, message: error.message };
        }
        report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
        report.marked = (await readdir(join(root, '.opm', report.copies[0], 'trees'))).includes('0.moving');
      `);
    expect(report.marked).toBe(true);
    expect(report.error).toEqual({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(
        /could not put node_modules back from \.opm\/\.rollback-.*read-only.*opm recover.*remove \.opm\/\.rollback-/u,
      ),
    });
    expect(report.error?.message).not.toMatch(
      /EROFS|EBUSY|rmdir|unlink|errno|syscall/iu,
    );
    expect(report.copies).toHaveLength(1);
  }, 60_000);

  it('says plainly that it cannot take the step lock of a read-only project (N6)', async () => {
    const report = await inMounts(`
      const { projectStep } = await import(${JSON.stringify(sources.index)});
      mount('--bind', root, root);
      mount('-o', 'remount,bind,ro', root);
      try {
        await projectStep(root, { waitMs: 0 }, async () => 'ran');
        report.error = { code: 'NONE', message: 'the step ran' };
      } catch (error) {
        report.error = { code: error.code, message: error.message };
      }
      report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('step-'));
    `);
    expect(report.error).toEqual({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(
        /^opm cannot change this project, because it cannot create a step lock in .*\.opm \(its file system is read-only\)\. Nothing was changed\.$/u,
      ),
    });
    expect(report.error?.message).not.toMatch(/\/proc\/self\/fd|EROFS|open '/u);
    expect(report.copies).toEqual([]);
  }, 60_000);

  it("keeps two projects that share one .opm from putting back or removing each other's copy", async () => {
    const report = await inMounts(`
      const { abandonStep } = await import(${JSON.stringify(sources.index)});
      const other = root + '-b';
      await mkdir(join(other, '.opm'), { recursive: true });
      await writeFile(join(other, 'opm.toml'), 'the other one\\n');
      mount('--bind', join(root, '.opm'), join(other, '.opm'));
      await snapshotProject(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\\n');
      await dead();
      const [name] = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      const errors: string[] = [];
      try { await recoverInterruptedSteps(other); } catch (error) { errors.push(error.code + ': ' + error.message); }
      try { await abandonStep(other, name.replace(/^[.]rollback-[0-9]+-/u, '')); } catch (error) { errors.push(error.code + ': ' + error.message); }
      report.leftovers = errors;
      report.copies = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
      report.manifest = await readFile(join(other, 'opm.toml'), 'utf8');
      report.recovered = await recoverInterruptedSteps(root);
      report.restored = (await readFile(join(root, 'opm.toml'), 'utf8')) !== 'half-written\\n';
      await rm(other, { recursive: true, force: true }).catch(() => undefined);
    `);
    expect(report.error).toBeUndefined();
    expect(report.leftovers).toEqual([
      expect.stringMatching(
        /^INVALID_ROLLBACK: .*shares this \.opm directory with .*run opm recover in /u,
      ),
      expect.stringMatching(
        /^INVALID_ROLLBACK: .*shares this \.opm directory with /u,
      ),
    ]);
    expect(report.copies).toHaveLength(1);
    expect(report.manifest).toBe('the other one\n');
    expect(report.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.restored).toBe(true);
  }, 60_000);

  it('recovers a project from a copy made under another name of its directory (a bind mount of it)', async () => {
    const report = await inMounts(`
      const alias = root + '-alias';
      await mkdir(alias);
      mount('--bind', root, alias);
      const before = await readFile(join(root, 'opm.toml'), 'utf8');
      await snapshotProject(alias);
      await writeFile(join(root, 'opm.toml'), 'half-written\\n');
      await dead();
      report.recovered = await recoverInterruptedSteps(root);
      report.restored = (await readFile(join(root, 'opm.toml'), 'utf8')) === before;
    `);
    expect(report.error).toBeUndefined();
    expect(report.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(report.restored).toBe(true);
  }, 60_000);
});
