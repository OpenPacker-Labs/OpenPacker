import { describe, expect, it } from 'vitest';
import {
  asProcessOwner,
  ownerPlace,
  UNKNOWN,
  type LeaseOwner,
} from '../src/lease-owner.js';
import { ownerPlace as sharedPlace } from '../src/process-owner.js';

/**
 * A lease's owner is placed by the one owner rule (`process-owner.ts`), its
 * fields mapped onto that rule's record, and the lease's file names are what
 * they were. The rule a lease was placed by before is kept below, as written in
 * `lease-owner.ts` then, and every combination of what the two sides read is
 * placed the same by both.
 */

/** The lease's own place rule, before it used the shared one. */
function placedBefore(
  owner: LeaseOwner,
  reader: LeaseOwner,
): 'ended' | 'elsewhere' | 'here' {
  const sameMachine =
    owner.machine === reader.machine && owner.host === reader.host;
  if (
    sameMachine &&
    owner.boot !== UNKNOWN &&
    reader.boot !== UNKNOWN &&
    owner.boot !== reader.boot
  )
    return 'ended';
  if (!sameMachine || owner.boot !== reader.boot) return 'elsewhere';
  if (owner.namespace !== reader.namespace) return 'elsewhere';
  if (process.platform === 'linux' && reader.namespace === UNKNOWN)
    return 'elsewhere';
  return 'here';
}

const reader: LeaseOwner = {
  pid: 4242,
  start: '1234',
  namespace: '4026531836',
  boot: 'b'.repeat(32),
  machine: 'a'.repeat(32),
  host: 'c'.repeat(16),
};

describe('a lease owner', () => {
  it('maps onto the shared record: `0` is a field not read, the rest as written', () => {
    expect(asProcessOwner(reader)).toEqual({
      pid: 4242,
      host: 'c'.repeat(16),
      machineId: 'a'.repeat(32),
      bootId: 'b'.repeat(32),
      pidNamespace: '4026531836',
      startTime: '1234',
    });
    expect(
      asProcessOwner({ ...reader, start: '0', namespace: '0', boot: '0' }),
    ).toEqual({ pid: 4242, host: 'c'.repeat(16), machineId: 'a'.repeat(32) });
  });

  it('is placed as it was, and as the shared rule places its record, whatever each side read', () => {
    const values = {
      machine: ['a'.repeat(32), 'd'.repeat(32)],
      host: ['c'.repeat(16), 'e'.repeat(16)],
      boot: ['b'.repeat(32), 'f'.repeat(32), UNKNOWN],
      namespace: ['4026531836', '4026532000', UNKNOWN],
    } as const;
    const owners: LeaseOwner[] = [];
    for (const machine of values.machine)
      for (const host of values.host)
        for (const boot of values.boot)
          for (const namespace of values.namespace)
            owners.push({ ...reader, pid: 7, machine, host, boot, namespace });
    const differ: string[] = [];
    const seen = new Set<string>();
    for (const owner of owners)
      for (const by of owners) {
        const before = placedBefore(owner, by);
        seen.add(before);
        const now = ownerPlace(owner, by);
        const shared = sharedPlace(asProcessOwner(owner), asProcessOwner(by), {
          unreadableNamespaceIsForeign: true,
        });
        if (now !== before || shared !== before)
          differ.push(JSON.stringify({ owner, by, before, now, shared }));
      }
    expect(differ).toEqual([]);
    // Each answer is reached, so the table tells the rules apart.
    expect([...seen].sort()).toEqual(['elsewhere', 'ended', 'here']);
  });
});
