import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Running opmx in a child process and killing it with a signal while a
 * sandboxed tool runs: what a Ctrl-C, a service manager's SIGTERM or a closed
 * terminal's SIGHUP does to it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');

/** A module of this app, as an import specifier in a script. */
export const source = (path: string): string =>
  JSON.stringify(join(here, path));

/**
 * opmx runs under plain node, with no signal handler of its own; the runner
 * here (vite-node's Vite server) closes and exits on SIGTERM, so its handlers
 * are taken off first.
 */
export const PLAIN_NODE = `for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.removeAllListeners(name);`;

export const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

/** Every running process with `marker` among its arguments. */
function withMarker(marker: string): string[][] {
  const found: string[][] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/u.test(pid)) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (argv.includes(marker)) found.push(argv);
    } catch {
      // Ended meanwhile.
    }
  }
  return found;
}

export async function until(
  test: () => Promise<boolean> | boolean,
  what: string,
) {
  for (let tries = 0; tries < 600; tries += 1) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** `script` (a module) run in a child process: what it prints, and how it ends. */
export async function startScript(script: string, work: string) {
  const file = join(work, 'run.ts');
  await writeFile(file, script);
  const child = spawn(viteNode, [file], {
    cwd: join(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
    child.on('exit', (code, how) => resolve(how ?? code)),
  );
  return { child, exited, output: () => output.trim() };
}

/**
 * Run `script` (a module) in a child process, kill it with `signal` once the
 * tool, which carries `marker` among its arguments, is running and `made`
 * says what the run makes exists; then wait for the tool to end.
 */
export async function signalledScript(input: {
  script: string;
  work: string;
  marker: string;
  signal: NodeJS.Signals;
  made: () => Promise<boolean>;
}) {
  const { child, exited, output } = await startScript(input.script, input.work);
  // The tool itself, not only bwrap, which carries the same arguments.
  await until(
    () =>
      withMarker(input.marker).some((argv) => !argv[0]!.endsWith('bwrap')) ||
      child.exitCode !== null,
    'the tool to start',
  );
  const state = [child.exitCode, await input.made()];
  if (state[0] !== null || state[1] !== true)
    throw new Error(
      `the run was not under way: ${state.join(' ')}\n${output()}`,
    );
  child.kill(input.signal);
  const how = await exited;
  await until(() => withMarker(input.marker).length === 0, 'the tool to end');
  return { how, output: output() };
}
