import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { describeNamespaced, mountNamespace } from './namespaces.js';
import {
  child,
  ended,
  project,
  sources,
  temporary,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * A node_modules that is a Docker volume, an opm.toml that is bind-mounted into
 * the project, a `.opm` on a volume of its own: the places a project is put
 * back into cannot always be removed or renamed over (X1). Each case runs in a
 * mount namespace of its own (`unshare`), so that nothing outlives the test.
 */

/** What the child reports, written beside the project. */
interface Report {
  restored?: boolean;
  recovered?: { restored: boolean }[];
  tree?: string[];
  expected?: string[];
  mounted?: boolean;
  marked?: boolean;
  manifest?: string;
  leftovers?: string[];
  copies?: string[];
  error?: { code: string; message: string };
}

/** Run `body` in a mount namespace with `mount`, `snapshotProject` and `recover` in scope. */
async function inMounts(body: string): Promise<Report> {
  const root = await project(['base']);
  const report = temporary(`${root}.report.json`);
  const run = await child(
    root,
    `import { execFileSync } from 'node:child_process';
     import { cp, lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';
     const mount = (...args: string[]) => execFileSync('mount', args);
     const { snapshotProject } = await import(${JSON.stringify(sources.rollback)});
     const { recoverInterruptedSteps } = await import(${JSON.stringify(sources.index)});
     const report: Record<string, unknown> = {};
     const listing = async (dir: string, base = dir): Promise<string[]> => {
       const out: string[] = [];
       for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
         const path = join(dir, entry.name);
         out.push(path.slice(base.length) + (entry.isDirectory() ? '/' : ''));
         if (entry.isDirectory()) out.push(...(await listing(path, base)));
       }
       return out;
     };
     /** The copy's owner has gone: the next step's business. */
     const dead = async () => {
       const { spawnSync } = await import('node:child_process');
       const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
       const [name] = (await readdir(join(root, '.opm'))).filter((n) => n.startsWith('.rollback-'));
       const path = join(root, '.opm', name, 'rollback.json');
       const record = JSON.parse(await readFile(path, 'utf8'));
       record.owner.pid = Number(exited.stdout);
       await writeFile(path, JSON.stringify(record));
     };
     const device = async (path: string) => (await stat(path)).dev;
     try {
       ${body}
     } catch (error) {
       report.error = { code: error.code, message: error.message };
     }
     await writeFile(${JSON.stringify(report)}, JSON.stringify(report));`,
    mountNamespace!,
  );
  expect(await ended(run)).toEqual({ code: 0, signal: null });
  // SAFETY: written by the child a moment ago.
  return JSON.parse(await readFile(report, 'utf8')) as Report;
}

/** node_modules as a volume that holds the installed tree. */
const VOLUME = `
  await cp(join(root, 'node_modules'), join(root, 'nm.save'), { recursive: true, verbatimSymlinks: true });
  mount('-t', 'tmpfs', 'tmpfs', join(root, 'node_modules'));
  await cp(join(root, 'nm.save'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  await rm(join(root, 'nm.save'), { recursive: true });
  report.expected = await listing(join(root, 'node_modules'));
`;

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
      `);
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
});
