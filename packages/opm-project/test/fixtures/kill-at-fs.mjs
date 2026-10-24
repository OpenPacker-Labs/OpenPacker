// Preloaded with `node --import`: kills this process (SIGKILL) just before the
// first `fs.promises[KILL_FS]` call whose first argument matches KILL_FS_ARG0
// and whose second matches KILL_FS_ARG1 (regular expressions; an empty one
// matches), so a test can stop a step or a recovery at one chosen point.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const name = process.env.KILL_FS;
const first = new RegExp(process.env.KILL_FS_ARG0 ?? '', 'u');
const second = new RegExp(process.env.KILL_FS_ARG1 ?? '', 'u');
const original = fs.promises[name];
fs.promises[name] = async (...args) => {
  if (first.test(String(args[0])) && second.test(String(args[1])))
    process.kill(process.pid, 'SIGKILL');
  return original(...args);
};
syncBuiltinESMExports();
