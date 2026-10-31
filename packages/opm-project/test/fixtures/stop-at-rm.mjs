// Preloaded with `node --import`: stops this process (SIGSTOP) just before it
// first removes a path that ends with STOP_AT_RM, so a test can hold it at one
// point of a recovery and let it go on with SIGCONT. A removal by path is an
// `fs.promises.rm` of it; a removal through a directory handle (Linux,
// `removeChild` in project-io) begins with the `lstat` of the name relative to
// the handle, `/proc/self/fd/N/<name>`, which nothing else does first.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const suffix = process.env.STOP_AT_RM;
const rm = fs.promises.rm;
const lstat = fs.promises.lstat;
let stopped = false;
function stopAt(path) {
  if (!stopped && suffix && String(path).endsWith(suffix)) {
    stopped = true;
    process.kill(process.pid, 'SIGSTOP');
  }
}
fs.promises.rm = async (...args) => {
  stopAt(args[0]);
  return rm(...args);
};
fs.promises.lstat = async (...args) => {
  if (String(args[0]).startsWith('/proc/self/fd/')) stopAt(args[0]);
  return lstat(...args);
};
syncBuiltinESMExports();
