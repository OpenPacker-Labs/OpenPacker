/**
 * Forged leases for the suites that judge a lease by who made it: this
 * process as a lease names its owner, read from what this machine says of it
 * (`/proc/self/stat`, `/etc/machine-id`, the kernel's boot id,
 * `/proc/self/ns/pid`) rather than taken from the module under test.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { leaseDirectory } from '../src/store-lease.js';

export const LINUX =
  process.platform === 'linux' && existsSync('/etc/machine-id');

export interface Owner {
  pid: number;
  start: string;
  namespace: string;
  machine: string;
  host: string;
  boot: string;
}

/** This process, as a lease names its owner. */
export async function me(): Promise<Owner> {
  const stat = await readFile('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
  const machine = (await readFile('/etc/machine-id', 'utf8')).trim();
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8'))
    .trim()
    .replaceAll('-', '');
  const link = await readlink('/proc/self/ns/pid');
  const namespace = /\[(\d+)\]/u.exec(link)![1]!;
  const host = createHash('sha256').update(hostname()).digest('hex');
  return {
    pid: process.pid,
    start,
    namespace,
    machine,
    host: host.slice(0, 16),
    boot,
  };
}

export function leaseId(how: string, owner: Owner): string {
  const { pid, start, namespace, machine, host, boot } = owner;
  return [
    'install',
    how,
    pid,
    start,
    namespace,
    machine,
    host,
    boot,
    randomUUID(),
  ].join('.');
}

/** A lease nobody holds open, claiming `key`, as a holder that died leaves. */
export async function forged(
  store: string,
  id: string,
  key: string,
): Promise<void> {
  const directory = leaseDirectory(store);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.lock`), '');
  await writeFile(join(directory, `${id}.keys`), `${key}\n`);
}

/** A pid no process has now. */
export function endedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}
