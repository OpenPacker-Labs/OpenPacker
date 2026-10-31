/**
 * Where the `npm`, `pnpm` and `yarn` shims are (ADR 0061): `shims/bin` of the
 * opm package, beside `dist`, written once and never by a run. Each starts its
 * script in `dist/shims` with the Node `npm_node_execpath` names.
 *
 * The paths are computed from this module's own place, so the source and the
 * build answer the same: `src/commands` and `dist/commands` are both two
 * levels below the package.
 */
import { join } from 'node:path';
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
