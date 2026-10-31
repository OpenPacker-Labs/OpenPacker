// Preloaded with `node --import`: counts the file-system calls a process makes
// and SIGKILLs it before call KILL_AT (KILL_LOG, if set, is told which call).
// It counts more than the calls the rollback code makes by name: open, cp,
// chmod, unlink, rmdir, utimes, stat, readlink, realpath, copyFile and the
// FileHandle methods writeFile, write, sync, chmod and truncate, so that a
// kill lands inside a write and between a flush and a rename as well.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const killAt = Number(process.env.KILL_AT ?? 0);
let n = 0;
const tick = (name, target) => {
  n += 1;
  if (killAt > 0 && n === killAt) {
    if (process.env.KILL_LOG)
      fs.appendFileSync(
        process.env.KILL_LOG,
        `${n} ${name} ${String(target)}\n`,
      );
    process.kill(process.pid, 'SIGKILL');
  }
};
for (const name of [
  'rename',
  'rm',
  'writeFile',
  'readFile',
  'lstat',
  'stat',
  'mkdir',
  'link',
  'copyFile',
  'symlink',
  'readdir',
  'open',
  'cp',
  'chmod',
  'unlink',
  'rmdir',
  'utimes',
  'readlink',
  'realpath',
]) {
  const original = fs.promises[name];
  if (typeof original !== 'function') continue;
  fs.promises[name] = async (...args) => {
    tick(name, args[0]);
    return original(...args);
  };
}
const probe = await fs.promises.open('/dev/null', 'r');
const proto = Object.getPrototypeOf(probe);
await probe.close();
for (const name of ['writeFile', 'write', 'sync', 'chmod', 'truncate']) {
  const original = proto[name];
  proto[name] = async function (...args) {
    tick(`fh.${name}`, this.fd);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
