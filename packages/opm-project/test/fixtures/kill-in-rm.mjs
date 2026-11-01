// Preloaded with `node --import`: SIGKILLs the process inside its `rm` of a
// kept tree of a copy (`.opm/.rollback-…/trees/<i>`) after deleting 40% of the
// entries under it, which is the state a kill part way through that `rm`
// leaves. A recovery that never removes a kept tree is never killed by it.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.promises.rm;
fs.promises.rm = async (path, ...rest) => {
  if (
    /\.rollback-[^/]+\/trees\/\d+$/u.test(String(path)) &&
    fs.existsSync(String(path))
  ) {
    const entries = fs.readdirSync(String(path)).sort();
    for (const entry of entries.slice(0, Math.floor(entries.length * 0.4)))
      fs.rmSync(`${path}/${entry}`, { recursive: true, force: true });
    process.kill(process.pid, 'SIGKILL');
  }
  return original(path, ...rest);
};
syncBuiltinESMExports();
