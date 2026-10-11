#!/usr/bin/env node
/** Process entry of `opm`, `opkg` and `opkgm`; see `entry.ts`. */
import { main } from './entry.js';

process.exitCode = await main(
  process.argv.slice(2),
  process,
  process.cwd(),
  async () => {
    const { runOpmFromProcess } = await import('./opm.js');
    return await runOpmFromProcess();
  },
);
