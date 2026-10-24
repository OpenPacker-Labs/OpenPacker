// Preloaded with `node --import`: stops this process (SIGSTOP) just before
// its first `fs.promises.rm` of a path that ends with STOP_AT_RM, so a test
// can hold it at one point of a recovery and let it go on with SIGCONT.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const suffix = process.env.STOP_AT_RM;
const rm = fs.promises.rm;
let stopped = false;
fs.promises.rm = async (...args) => {
  if (!stopped && suffix && String(args[0]).endsWith(suffix)) {
    stopped = true;
    process.kill(process.pid, 'SIGSTOP');
  }
  return rm(...args);
};
syncBuiltinESMExports();
