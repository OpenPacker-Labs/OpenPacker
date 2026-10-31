#!/usr/bin/env node
/**
 * `pnpm` inside `opm run` (ADR 0061): `shims/bin/pnpm` starts this with the Node
 * in `npm_node_execpath`. A script is run through `opm run`; anything else is
 * refused, naming what opm does instead (`commands/run-foreign.ts`).
 */
import { runForeign } from '../commands/run-foreign.js';

try {
  process.exitCode = await runForeign(
    'pnpm',
    process.argv.slice(2),
    process,
    process.cwd(),
  );
} catch (error) {
  // What `opm` itself does with a failure that is not the run's own.
  const { handleError } = await import('../opm.js');
  process.exitCode = handleError(error, process);
}
