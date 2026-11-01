// Preloaded with `node --import`: SIGKILLs the process inside the first
// FileHandle.writeFile whose descriptor is a file named opm.toml itself: the
// in-place write of a bind-mounted opm.toml, after O_TRUNC and before the
// bytes (the temporary name `.opm.toml.opm-restore` is not that file).
import fs from 'node:fs';

const probe = await fs.promises.open('/dev/null', 'r');
const proto = Object.getPrototypeOf(probe);
await probe.close();
const original = proto.writeFile;
proto.writeFile = async function (...args) {
  let target = '';
  try {
    target = fs.readlinkSync(`/proc/self/fd/${this.fd}`);
  } catch {
    // not a file
  }
  if (target.endsWith('/opm.toml')) process.kill(process.pid, 'SIGKILL');
  return original.apply(this, args);
};
