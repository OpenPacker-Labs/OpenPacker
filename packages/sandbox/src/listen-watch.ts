import { readFileSync, readlinkSync } from 'node:fs';

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

function namespaceOf(pid: number | 'self'): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return undefined;
  }
}

/** The ports listened on in the namespace `pid` is in, lowest first. */
function listeningPorts(pid: number): number[] {
  const ports = new Set<number>();
  for (const table of ['tcp', 'tcp6']) {
    const rows = read(`/proc/${pid}/net/${table}`)?.split('\n').slice(1) ?? [];
    for (const row of rows) {
      const [, local, , state] = row.trim().split(/\s+/u);
      if (state !== LISTEN || local === undefined) continue;
      const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16);
      if (Number.isSafeInteger(port) && port > 0) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * The lowest port a process started by `rootPid` listens on in a network
 * namespace other than the caller's, if there is one.
 */
export function isolatedListenPort(rootPid: number): number | undefined {
  const own = namespaceOf('self');
  if (own === undefined) return undefined;
  const children = read(`/proc/${rootPid}/task/${rootPid}/children`);
  for (const child of children?.trim().split(/\s+/u) ?? []) {
    const pid = Number(child);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const namespace = namespaceOf(pid);
    if (namespace === undefined || namespace === own) continue;
    return listeningPorts(pid)[0];
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
