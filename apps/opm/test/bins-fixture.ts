/**
 * What `bins.test.ts` runs: the bins as a package manager lays them down (a
 * link to the built file, which Node starts with the link's own path as
 * `process.argv[1]`), and a one-bin package that exits with the code it is
 * given, installable offline.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach } from 'vitest';
import { tar } from './plugin-fixture.js';

export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  // realpath: a temporary directory may sit behind a link of its own, and the
  // tests compare a link's path with the path it resolves to.
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(directory);
  return directory;
}

export interface Finished {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * `<name>` linked to its built target, as `npm i` lays out `node_modules/.bin`.
 * Returns the path to start Node on for each bin.
 *
 * Windows has no such link without a privilege, so there a junction to the
 * build directory stands in: the bin is a file inside it, and Node resolves
 * the junction for the module's URL just as it resolves a symbolic link.
 */
export async function linkBins(
  bins: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const home = await tempDirectory('opm-bins-');
  const entries = new Map<string, string>();
  if (process.platform === 'win32') {
    const dist = join(home, 'dist');
    await symlink(join(appRoot, 'dist'), dist, 'junction');
    for (const [name, target] of Object.entries(bins))
      entries.set(name, join(dist, basename(target)));
    return entries;
  }
  const directory = join(home, '.bin');
  await mkdir(directory);
  for (const [name, target] of Object.entries(bins)) {
    await symlink(join(appRoot, target), join(directory, name));
    entries.set(name, join(directory, name));
  }
  return entries;
}

/** Start a bin the way its link is started: Node, then the link's path. */
export function run(
  entry: string,
  args: readonly string[],
  cwd: string,
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: {
        ...process.env,
        // No user-level store: a test writes nothing outside its directories.
        OPM_STORE_HOME: 'off',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) =>
      resolve({ status, signal, stdout, stderr }),
    );
  });
}

export const EXIT_TOOL_PURL = 'pkg:npm/@openpacker/exit-tool@1.0.0';

/**
 * A project directory whose catalog offers `exit-tool`, a package with one bin
 * that prints a line and exits with its first argument.
 */
export async function makeExitToolProject(): Promise<string> {
  const root = await tempDirectory('opm-exit-tool-');
  const text = (value: string) => new TextEncoder().encode(value);
  const archive = gzipSync(
    tar([
      {
        name: 'package/package.json',
        data: text(
          JSON.stringify({
            name: '@openpacker/exit-tool',
            version: '1.0.0',
            bin: { 'exit-tool': 'bin/exit-tool.js' },
          }),
        ),
        mode: 0o644,
      },
      {
        name: 'package/bin/exit-tool.js',
        data: text(
          "console.log('exit-tool ran');\nprocess.exit(Number(process.argv[2]));\n",
        ),
        mode: 0o755,
      },
    ]),
  );
  const source = join(root, 'exit-tool-1.0.0.tgz');
  await writeFile(source, archive);
  await mkdir(join(root, '.opm'));
  const catalog = {
    schemaVersion: 1,
    packages: {
      'pkg:npm/%40openpacker/exit-tool@1.0.0': {
        purl: 'pkg:npm/%40openpacker/exit-tool@1.0.0',
        version: '1.0.0',
        digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        size: archive.byteLength,
        format: 'tar+gzip',
        mediaType: 'application/vnd.npm.package+gzip',
        source: `file:${source}`,
        bins: [{ name: 'exit-tool', path: 'package/bin/exit-tool.js' }],
      },
    },
  };
  await writeFile(
    join(root, '.opm', 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  return root;
}
