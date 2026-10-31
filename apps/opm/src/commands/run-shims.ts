/**
 * Where the `npm`, `pnpm` and `yarn` shims are (ADR 0061): `shims/bin` of the
 * opm package, beside `dist`, written once and never by a run. Each starts its
 * script in `dist/shims` with the Node `npm_node_execpath` names.
 *
 * The paths are computed from this module's own place, so the source and the
 * build answer the same: `src/commands` and `dist/commands` are both two
 * levels below the package.
 */
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunShims } from './run-paths.js';

/** The opm package's directory: `apps/opm` in this repository. */
export const OPM_PACKAGE_ROOT = fileURLToPath(
  new URL('../../', import.meta.url),
);

/** The shims of the opm package this module belongs to, started with `node`. */
export function packageShims(
  root: string = OPM_PACKAGE_ROOT,
  node: string = process.execPath,
): RunShims {
  return {
    bin: join(root, 'shims', 'bin'),
    npmExecpath: join(root, 'dist', 'shims', 'npm.js'),
    node,
  };
}

/**
 * The shims as an approved install script gets them inside the jail
 * (ADR 0060 §3, ADR 0061): first on its PATH, the opm package mounted
 * read-only so that they and the `opm run` they start can be read (and never
 * written), and `@openpacker/canonical`, which `opm run` loads to word a
 * failure, mounted where Node resolves it from the package: its own directory,
 * and the directory of the link to it when it is reached through one (an npm
 * workspace links it from `node_modules/@openpacker`). Every path is a real
 * one, as the jail requires.
 */
export async function jailShims(root: string = OPM_PACKAGE_ROOT): Promise<{
  bin: string;
  readonlyPaths: string[];
  env: Record<string, string>;
}> {
  const real = await realpath(root);
  const shims = packageShims(real);
  const readonlyPaths = [real];
  for (let dir = join(real, 'dist', 'commands'); ; dir = dirname(dir)) {
    const lexical = join(dir, 'node_modules', '@openpacker', 'canonical');
    const info = await lstat(lexical).catch(() => undefined);
    if (info !== undefined) {
      const target = await realpath(lexical);
      const parent = dirname(lexical);
      if (info.isSymbolicLink() && (await realpath(parent)) === parent)
        readonlyPaths.push(parent);
      if (!target.startsWith(`${real}/`)) readonlyPaths.push(target);
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return {
    bin: shims.bin,
    readonlyPaths,
    env: { npm_execpath: shims.npmExecpath, npm_node_execpath: shims.node },
  };
}
