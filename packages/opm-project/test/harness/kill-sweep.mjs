// A recovery, or a step, killed before each of its file-system calls in turn
// (kill-hook.mjs), and then the next recovery: the project must be exactly as
// it was before the killed step, with no copy and no lock left.
//
//   node kill-sweep.mjs recovery [plain|volume|bindfile|opmvolume] [scratch]
//   node kill-sweep.mjs step [scratch]      a step killed at sampled calls
//   node kill-sweep.mjs locked [scratch]    the same step under the real lock
//
// SWEEP_START=<k> starts a recovery sweep at call k. Do not rebuild the
// package while a sweep runs: a child that loads a half-written file fails by
// itself, and the sweep stops there and says so.
//
// The layouts other than `plain` put the project on mounts (node_modules as a
// volume, opm.toml bind-mounted, .opm on a volume of its own) and run in a
// mount namespace (`unshare --mount`, as root or through a user namespace). A
// machine that refuses both fails the sweep; it never skips it.
// OPM_PROJECT_DIST is the dist/esm of @openpacker/opm-project (default: this
// package's own build).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.OPM_PROJECT_DIST ?? join(here, '../../dist/esm');
const load = (name) => import(pathToFileURL(join(DIST, name)).href);
const hook = join(here, 'kill-hook.mjs');
const [mode, ...rest] = process.argv.slice(2);

/** A project with every file and tree a copy keeps. */
async function makeProject(root) {
  for (const dir of ['bin', 'links', 'generations'])
    await mkdir(join(root, '.opm', dir), { recursive: true });
  await writeFile(join(root, 'opm.toml'), '[project]\nname = "demo"\n');
  await writeFile(join(root, 'opm.lock.json'), '{"lockVersion":1}\n');
  await writeFile(join(root, 'package.json'), '{"name":"demo"}\n');
  await writeFile(join(root, '.opm', 'project.json'), '{"schemaVersion":1}\n');
  await writeFile(join(root, '.opm', 'native.json'), '{"n":1}\n');
  await writeFile(
    join(root, '.opm', 'environment.json'),
    '{"currentGenerationDigest":"g2"}\n',
  );
  for (const g of ['g1', 'g2'])
    await writeFile(
      join(root, '.opm', 'generations', `${g}.json`),
      `{"id":"${g}"}\n`,
    );
  await writeFile(join(root, '.opm', 'bin', 'tool'), '#!/bin/sh\necho tool\n', {
    mode: 0o755,
  });
  await symlink('../../node_modules/a', join(root, '.opm', 'links', 'a'));
  for (let p = 0; p < 40; p += 1) {
    const dir = join(root, 'node_modules', `pkg${p}`, 'lib');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(root, 'node_modules', `pkg${p}`, 'package.json'),
      `{"name":"pkg${p}"}\n`,
    );
    for (let f = 0; f < 10; f += 1)
      await writeFile(
        join(dir, `f${f}.js`),
        `module.exports=${p * 100 + f};\n`,
      );
  }
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await symlink(
    '../pkg1/lib/f0.js',
    join(root, 'node_modules', '.bin', 'pkg1'),
  );
}

/** The writes a step makes once its copy is kept, cut short. */
async function halfWay(root, kept) {
  await kept.noteWrite(join(root, 'package.json'), '{"name":"half"}\n');
  await writeFile(join(root, 'package.json'), '{"name":"half"}\n');
  await writeFile(join(root, 'opm.toml'), 'half-written\n');
  await writeFile(join(root, 'opm.lock.json'), '{}\n');
  await writeFile(
    join(root, '.opm', 'environment.json'),
    '{"currentGenerationDigest":"g3"}\n',
  );
  await writeFile(
    join(root, '.opm', 'generations', 'g3.json'),
    '{"id":"g3"}\n',
  );
  await rm(join(root, 'node_modules', 'pkg3'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'stray.js'), 'half\n');
}

/** Kind, mode and bytes of every entry, the copies excluded. */
async function digest(root, dir = root, into = {}) {
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const path = join(dir, name);
    const rel = relative(root, path);
    if (rel.startsWith(join('.opm', '.rollback-'))) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink()) into[rel] = `link ${await readlink(path)}`;
    else if (info.isDirectory()) {
      into[rel] = `dir ${(info.mode & 0o7777).toString(8)}`;
      await digest(root, path, into);
    } else
      into[rel] = `file ${(info.mode & 0o7777).toString(8)} ${createHash(
        'sha256',
      )
        .update(await readFile(path))
        .digest('hex')
        .slice(0, 12)}`;
  }
  return into;
}

const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((key) => a[key] !== b[key])
    .map((key) => `${key}: ${a[key] ?? '(absent)'} -> ${b[key] ?? '(absent)'}`);

const copies = async (root) =>
  (await readdir(join(root, '.opm')).catch(() => [])).filter((name) =>
    name.startsWith('.rollback-'),
  );

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
const mount = (...args) => {
  const result = run('mount', args);
  if (result.status !== 0)
    throw new Error(`mount ${args.join(' ')}: ${result.stderr}`);
};

/** Put the project on mounts, as the layout says; returns the mount points. */
async function layOut(layout, root) {
  const aside = `${root}.aside`;
  await rm(aside, { recursive: true, force: true });
  if (layout === 'volume') {
    await cp(join(root, 'node_modules'), aside, {
      recursive: true,
      verbatimSymlinks: true,
    });
    mount('-t', 'tmpfs', 'tmpfs', join(root, 'node_modules'));
    await cp(aside, join(root, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await rm(aside, { recursive: true });
    return [join(root, 'node_modules')];
  }
  if (layout === 'opmvolume') {
    await cp(join(root, '.opm'), aside, {
      recursive: true,
      verbatimSymlinks: true,
    });
    mount('-t', 'tmpfs', 'tmpfs', join(root, '.opm'));
    await cp(aside, join(root, '.opm'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await rm(aside, { recursive: true });
    return [join(root, '.opm')];
  }
  if (layout === 'bindfile') {
    await cp(join(root, 'opm.toml'), aside);
    mount('--bind', aside, join(root, 'opm.toml'));
    return [join(root, 'opm.toml')];
  }
  return [];
}

async function child(name, root) {
  const { recoverInterruptedSteps, projectStep } =
    await load('project-step.js');
  const { snapshotProject } = await load('project-rollback.js');
  if (name === 'recover') {
    await recoverInterruptedSteps(root, { waitMs: 15000 });
    return;
  }
  const take = async () => {
    const kept = await snapshotProject(root, {
      manifest: 'half-written\n',
      lock: '{}\n',
    });
    await halfWay(root, kept);
    process.kill(process.pid, 'SIGKILL');
  };
  if (name === 'step') await take();
  else await projectStep(root, { waitMs: 0 }, take);
}
if (mode === '--child') {
  await child(rest[0], rest[1]);
  process.exit(0);
}

/** Run this script as a child of `kind` on `root`, with the kill hook at `k` (0: none). */
const spawnChild = (kind, root, k, log) =>
  spawnSync(
    process.execPath,
    [
      ...(k > 0 ? ['--import', hook] : []),
      fileURLToPath(import.meta.url),
      '--child',
      kind,
      root,
    ],
    {
      env: {
        ...process.env,
        ...(k > 0 && { KILL_AT: String(k), KILL_LOG: log }),
      },
      encoding: 'utf8',
    },
  );

const layout = mode === 'recovery' ? (rest[0] ?? 'plain') : 'plain';
const scratch =
  (mode === 'recovery' ? rest[1] : rest[0]) ??
  join(process.env.TMPDIR ?? '/tmp', `opm-kill-sweep-${process.pid}`);

if (layout !== 'plain' && process.env.OPM_SWEEP_MOUNTS !== '1') {
  // Mounts need a namespace of their own: as root, or through a user namespace.
  for (const prefix of [
    ['--mount'],
    ['--user', '--map-root-user', '--mount'],
  ]) {
    if (spawnSync('unshare', [...prefix, 'true']).status !== 0) continue;
    const result = spawnSync(
      'unshare',
      [...prefix, process.execPath, ...process.argv.slice(1)],
      {
        stdio: 'inherit',
        env: { ...process.env, OPM_SWEEP_MOUNTS: '1' },
      },
    );
    process.exit(result.status ?? 1);
  }
  console.error(
    'kill-sweep: `unshare --mount` is refused here (as root and through a user namespace); the mount layouts cannot be swept',
  );
  process.exit(2);
}
if (!['recovery', 'step', 'locked'].includes(mode ?? '')) {
  console.error(
    'usage: node kill-sweep.mjs recovery [plain|volume|bindfile|opmvolume] [scratch] | step [scratch] | locked [scratch]',
  );
  process.exit(2);
}

await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const work = join(scratch, 'work');
const log = join(scratch, 'kill.log');
const { recoverInterruptedSteps } = await load('project-step.js');
let bad = 0;
let tried = 0;
/** The call a recovery that failed by itself stopped the sweep at. */
let stopped;
const kinds = { restored: 0, removed: 0, none: 0 };

/** A fresh project in this layout; the digest to come back to. */
async function fresh() {
  await rm(work, { recursive: true, force: true });
  await rm(log, { force: true });
  await makeProject(work);
  const mounts = await layOut(layout, work);
  return { mounts, before: await digest(work) };
}
async function clean(mounts) {
  for (const point of mounts) run('umount', ['-l', point]);
  await rm(work, { recursive: true, force: true });
}

/**
 * Kill the recovery (or the step) at call `k` and check what the next
 * recovery leaves. Returns false once `k` is past the last call.
 */
async function point(k) {
  const { mounts, before } = await fresh();
  try {
    let killed;
    if (mode === 'recovery') {
      // The step the recovery recovers is killed by itself, at the end of its half way.
      spawnChild('step', work, 0, log);
      if ((await copies(work)).length !== 1)
        throw new Error('the killed step left no copy');
      killed = spawnChild('recover', work, k, log);
    } else
      killed = spawnChild(mode === 'step' ? 'step' : 'locked', work, k, log);
    const reached = killed.signal === 'SIGKILL' && existsSync(log);
    if (mode === 'recovery' && !reached && killed.status !== 0) {
      // Neither killed by the hook nor run to the end: the run says nothing
      // about call k (a dist rebuilt under it, a machine out of something).
      bad += 1;
      stopped = k;
      console.log(
        `k=${k}: the recovery failed by itself (status ${killed.status}, signal ${killed.signal}): ${String(killed.stderr).slice(-400)}`,
      );
      return false;
    }
    if (mode === 'recovery' && !reached) {
      // Ran to the end: the project is already as it was.
      const d = diff(before, await digest(work));
      if (d.length > 0 || (await copies(work)).length > 0) {
        bad += 1;
        console.log(
          `k=${k}: the recovery ended without being killed, WRONG: ${d.slice(0, 4).join('; ')}`,
        );
      }
      return false;
    }
    tried += 1;
    // A kill between creating a lock file and writing it leaves an empty file,
    // held for 5 s (step-lock.ts) before it counts as a leftover: wait it out.
    const result = await recoverInterruptedSteps(work, {
      waitMs: 15000,
    }).catch((error) => error);
    if (result instanceof Error) {
      bad += 1;
      console.log(
        `k=${k}: the next recovery THREW ${result.code ?? ''} ${result.message.slice(0, 200)}`,
      );
      return reached;
    }
    if (result.length === 0) kinds.none += 1;
    for (const r of result) kinds[r.restored ? 'restored' : 'removed'] += 1;
    const d = diff(before, await digest(work));
    const left = await copies(work);
    const locks = (await readdir(join(work, '.opm'))).filter((n) =>
      n.startsWith('step-'),
    );
    if (d.length > 0 || left.length > 0 || locks.length > 0) {
      bad += 1;
      console.log(
        `k=${k}: WRONG ${d.slice(0, 4).join('; ')} copies=${left} locks=${locks}`,
      );
    }
    return reached;
  } finally {
    await clean(mounts);
  }
}

if (mode === 'recovery') {
  // SWEEP_START resumes a sweep at that call.
  const start = Number(process.env.SWEEP_START ?? 1);
  let k = start;
  while (await point(k)) k += 1;
  console.log(
    `${layout}: ${tried} kill points of the recovery (calls ${start} to ${start + tried - 1}); ${bad === 0 ? 'every kill point recovered exactly' : `${bad} wrong`}${stopped === undefined ? '' : `; stopped at ${stopped}, resume with SWEEP_START=${stopped}`}`,
  );
} else {
  let k = 1;
  for (; k <= 40; k += 1) await point(k);
  for (; await point(k); k += 29);
  const last = k;
  for (let j = Math.max(41, last - 60); j < last; j += 1) await point(j);
  console.log(`the step makes about ${last} file-system calls`);
  console.log(
    `${tried} kill points; recoveries: ${JSON.stringify(kinds)}; ${bad === 0 ? 'every one left the project as before, no copy, no lock' : `${bad} wrong`}`,
  );
}
await rm(scratch, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
