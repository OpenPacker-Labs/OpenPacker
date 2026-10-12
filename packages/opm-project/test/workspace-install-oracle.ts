/**
 * What an install left on disk, in the form `install-oracle.cjs` (adapter-npm,
 * `test/workspace-oracle/`) prints what npm's arborist would install:
 * `<path>|<name>|<version>|` for a package and
 * `<path>|<name>|<version>|-> <target>` for a member's link.
 */

import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORACLE = new URL(
  '../../adapter-npm/test/workspace-oracle/install-oracle.cjs',
  import.meta.url,
);

/**
 * What arborist (the npm that comes with this Node) says `npm ci` installs
 * into `dir`, for the options the oracle takes (`--omit`, `--workspace`, …).
 * Only for recording: the suites replay what this once said.
 */
export function askOracle(dir: string, oracle: readonly string[]): string[] {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(ORACLE), dir, ...oracle, '--print-expected'],
      { encoding: 'utf8' },
    ),
  ) as string[];
}

/** Every package in the project's `node_modules` and in each member's, links not followed into. */
export async function walkInstalled(
  directory: string,
  memberDirs: readonly string[],
): Promise<string[]> {
  // A link's target is a real path, so the project is named by its real path too.
  const projectDir = await realpath(directory);
  const found = new Set<string>();
  const rel = (path: string) =>
    relative(projectDir, path).split('\\').join('/');
  const manifestOf = async (dir: string) =>
    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
  const modules = async (base: string): Promise<void> => {
    const dir = join(base, 'node_modules');
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const entries = name.startsWith('@')
        ? (await readdir(join(dir, name))).map((n) => `${name}/${n}`)
        : [name];
      for (const entry of entries) {
        const at = join(dir, entry);
        if ((await lstat(at)).isSymbolicLink()) {
          const target = await realpath(at);
          const manifest = await manifestOf(target);
          found.add(
            `${rel(at)}|${entry}|${manifest.version}|-> ${rel(target)}`,
          );
          continue;
        }
        const manifest = await manifestOf(at);
        found.add(`${rel(at)}|${manifest.name}|${manifest.version}|`);
        await modules(at);
      }
    }
  };
  await modules(projectDir);
  for (const member of memberDirs) await modules(join(projectDir, member));
  return [...found].sort();
}
