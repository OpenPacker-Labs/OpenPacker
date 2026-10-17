import { createHmac } from 'node:crypto';

/**
 * The machine and the boot of an owner are kept as digests, not as the ids the
 * system gives (`/etc/machine-id`, `/proc/sys/kernel/random/boot_id`).
 * machine-id(5) says the machine id is confidential and that an application
 * should only ever use a keyed hash of it; an owner record sits in a project
 * directory that is committed, cached and shared. The rule needs equality and
 * nothing else, which a keyed digest keeps.
 */

export type PlaceKind = 'machine' | 'boot';

/** A digest as {@link placeDigest} writes it: `d1-` and 32 hex digits. */
const DIGEST = /^d1-[0-9a-f]{32}$/u;

/** The ids an earlier opm wrote raw, and so what a record still holds. */
const RAW: Record<PlaceKind, RegExp> = {
  machine: /^[0-9a-f]{32}$/u,
  boot: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
};

/**
 * HMAC-SHA-256 of `raw`, keyed by what it names (`opm.owner.machine.v1`,
 * `opm.owner.boot.v1`), 32 hex digits behind `d1-`. The same id as a machine
 * and as a boot are two digests, and neither gives the id back.
 */
export function placeDigest(kind: PlaceKind, raw: string): string {
  const key = `opm.owner.${kind}.v1`;
  return `d1-${createHmac('sha256', key).update(raw).digest('hex').slice(0, 32)}`;
}

/**
 * A field of a record read back: a digest stays, an id in the form an earlier
 * opm wrote raw becomes its digest, anything else (an adapter's own digest of
 * the host name, see the header of `process-owner.ts`) stays as it is.
 */
export function asPlaceDigest(kind: PlaceKind, value: string): string {
  return !DIGEST.test(value) && RAW[kind].test(value)
    ? placeDigest(kind, value)
    : value;
}
