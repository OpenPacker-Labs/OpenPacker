import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { mountNamespace } from './namespaces.js';
import {
  child,
  ended,
  project,
  sources,
  temporary,
  viteNode,
} from './rollback-support.js';

/**
 * A project in a mount namespace of its own (`unshare --mount`): the child
 * script gets `mount`, `snapshotProject`, `recoverInterruptedSteps`, a
 * listing, a dead owner for the copy, and writes what it saw as a report.
 */

/** What the child reports, written beside the project. */
export interface Report {
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
  killedBy?: string | null;
  second?: { restored: boolean }[];
  secondError?: { code: string; message: string };
  before?: string[];
  after?: string[];
  afterKill?: string;
  mode?: number;
  text?: string;
}

/** Run `body` in a mount namespace with `mount`, `snapshotProject` and `recover` in scope. */
export async function inMounts(body: string): Promise<Report> {
  const root = await project(['base']);
  const report = temporary(`${root}.report.json`);
  // What a body makes beside the project (another project, a second name for
  // it), removed after the test like the project; its mounts were the child's.
  temporary(`${root}-b`);
  temporary(`${root}-alias`);
  // And the script a killed recovery runs (`killedRecovery`), written beside it.
  temporary(`${root}-recover.ts`);
  const run = await child(
    root,
    `import { execFileSync } from 'node:child_process';
     import { chmod, cp, lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';
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
     /** A recovery in a process of its own, with the hook file preloaded; what ended it. */
     const killedRecovery = async (hook: string) => {
       const { spawnSync } = await import('node:child_process');
       const indexPath = ${JSON.stringify(sources.index)};
       const script = root + '-recover.ts';
       await writeFile(script, 'import { recoverInterruptedSteps } from ' + JSON.stringify(indexPath) + ';\\nawait recoverInterruptedSteps(' + JSON.stringify(root) + ', { waitMs: 0 });\\n');
       const run = spawnSync(${JSON.stringify(viteNode)}, [script], {
         env: { ...process.env, NODE_OPTIONS: '--import=' + hook },
       });
       return run.signal ?? run.status;
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
export const VOLUME = `
  await cp(join(root, 'node_modules'), join(root, 'nm.save'), { recursive: true, verbatimSymlinks: true });
  mount('-t', 'tmpfs', 'tmpfs', join(root, 'node_modules'));
  await cp(join(root, 'nm.save'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  await rm(join(root, 'nm.save'), { recursive: true });
  report.expected = await listing(join(root, 'node_modules'));
`;
