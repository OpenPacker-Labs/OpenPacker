#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cliEntry = require.resolve('@openpacker/cli/dist/index.js');
const result = spawnSync(
  process.execPath,
  [cliEntry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? (result.signal ? 1 : 0));
