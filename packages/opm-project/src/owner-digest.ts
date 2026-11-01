import { createHmac } from 'node:crypto';

/**
 * The machine and the boot of an owner this code writes are digests, not the ids the
 * system gives (`/etc/machine-id`, `/proc/sys/kernel/random/boot_id`).
 * machine-id(5) says the machine id is confidential and that an application
 * should only ever use a keyed hash of it; an owner record sits in a project
 * directory that is committed, cached and shared. The rule needs equality and
 * nothing else, which a keyed digest keeps.
 */

export type PlaceKind = 'machine' | 'boot';

/**
 * HMAC-SHA-256 of `raw`, keyed by what it names (`opm.owner.machine.v1`,
 * `opm.owner.boot.v1`), 32 hex digits behind `d1-`. The same id as a machine
 * and as a boot are two digests, and neither gives the id back.
 */
export function placeDigest(kind: PlaceKind, raw: string): string {
  const key = `opm.owner.${kind}.v1`;
  return `d1-${createHmac('sha256', key).update(raw).digest('hex').slice(0, 32)}`;
}
