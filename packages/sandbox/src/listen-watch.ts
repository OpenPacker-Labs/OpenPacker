import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';

/**
 * A process run without network (bwrap's `--unshare-net`) has a network
 * namespace of its own, with a loopback interface and nothing else: a server
 * there listens, says so, and is never reached from the host. Nothing tells
 * it; Linux reports the sockets of a namespace in `/proc/<pid>/net/tcp` and
 * `tcp6` of any process in it, so the sandbox can.
 *
 * `rootPid` is the process the backend started (bwrap), which stays in the
 * caller's namespace; the processes it starts (`/proc/<pid>/task/<pid>/children`)
 * are in the run's. Only a namespace other than the caller's is read, so a run
 * that shares the host's network is never reported. Anything that cannot be
 * read (another kernel, no `children` file, a process that ended meanwhile)
 * reports nothing.
 *
 * A child's parent, namespace and socket table are read through one handle of
 * its `/proc/<pid>` directory: a handle names the process it was opened on,
 * so a pid that ends and is given to another process between the reads gives
 * nothing, never the other process's table, and a pid given to another
 * process before the handle was opened is not the root's child, and is not
 * read either.
 */

/** TCP's LISTEN state, as `/proc/<pid>/net/tcp` writes it. */
const LISTEN = '0A';

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function ownNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/net');
  } catch {
    return undefined;
  }
}

/** The ports listened on in the namespace of the process `dir` is the `/proc` directory of. */
function listeningPorts(dir: string): number[] {
  const ports = new Set<number>();
  for (const table of ['tcp', 'tcp6']) {
    const rows = read(`${dir}/net/${table}`)?.split('\n').slice(1) ?? [];
    for (const row of rows) {
      const [, local, , state] = row.trim().split(/\s+/u);
      if (state !== LISTEN || local === undefined) continue;
      const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16);
      if (Number.isSafeInteger(port) && port > 0) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** The parent of the process `dir` is the `/proc` directory of, as its `status` says. */
function parentOf(dir: string): number | undefined {
  const line = read(`${dir}/status`)
    ?.split('\n')
    .find((row) => row.startsWith('PPid:'));
  const parent = Number(line?.slice('PPid:'.length).trim());
  return Number.isSafeInteger(parent) ? parent : undefined;
}

/** The pids `/proc` lists as `pid`'s children, when it lists them. */
function listedChildren(pid: number): number[] {
  return (
    read(`/proc/${pid}/task/${pid}/children`)
      ?.trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number) ?? []
  );
}

/**
 * The lowest port a process started by `rootPid` listens on in a network
 * namespace other than the caller's, if there is one.
 */
export function isolatedListenPort(
  rootPid: number,
  childrenOf: (pid: number) => readonly number[] = listedChildren,
): number | undefined {
  const own = ownNamespace();
  if (own === undefined) return undefined;
  for (const pid of childrenOf(rootPid)) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let handle: number;
    try {
      handle = openSync(
        `/proc/${pid}`,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
    } catch {
      continue;
    }
    try {
      // Every read through the one handle: the same process, or nothing.
      const dir = `/proc/self/fd/${handle}`;
      // Still the root's child: a pid that ended and was given to another
      // process since it was listed names that process, which is not read.
      if (parentOf(dir) !== rootPid) continue;
      let namespace: string;
      try {
        namespace = readlinkSync(`${dir}/ns/net`);
      } catch {
        continue;
      }
      if (namespace === own) continue;
      return listeningPorts(dir)[0];
    } finally {
      closeSync(handle);
    }
  }
  return undefined;
}

/**
 * Look every `everyMs` for a port listened on in the run's own network
 * namespace, and tell `onListen` the first one, once. Returns how to stop
 * looking; it stops by itself once it has told.
 */
export function watchIsolatedListen(
  rootPid: number,
  onListen: (port: number) => void,
  everyMs = 200,
): () => void {
  const timer = setInterval(() => {
    const port = isolatedListenPort(rootPid);
    if (port === undefined) return;
    clearInterval(timer);
    onListen(port);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
