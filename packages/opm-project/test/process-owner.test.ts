import { describe, expect, it } from 'vitest';
import {
  describeProcessOwner,
  isOwnerAlive,
  ownerKey,
  ownerPlace,
  parseProcessOwner,
  type OwnerProbe,
  type PlaceOptions,
  type ProcessOwner,
} from '../src/index.js';

/**
 * The owner rule, over every combination of what is readable on either side
 * (the table in the header of `process-owner.ts`), with the system replaced by
 * a probe so that each branch runs on any machine: EPERM, a zombie, a start
 * time that differs, a `/proc` that is another PID namespace's.
 */

const BOOT = '9f7295d1-5100-478f-84e5-84ce9db4b369';
const EARLIER = '00000000-0000-4000-8000-000000000000';
const MACHINE = '4c398f739c8447eb99d3fe100ad1b0fa';

/** The process judging. */
const reader: ProcessOwner = {
  pid: 100,
  host: 'vm',
  startTime: '500',
  pidNamespace: '4026531836',
  bootId: BOOT,
  machineId: MACHINE,
};
/** An owner of the same place; its pid is another. */
const owner: ProcessOwner = { ...reader, pid: 4242, startTime: '777' };

const without = (value: ProcessOwner, field: keyof ProcessOwner) => {
  const { [field]: _gone, ...rest } = value;
  // SAFETY: only an optional field is taken out (host and pid are never named).
  return rest as ProcessOwner;
};

describe('where an owner runs, seen from a reader', () => {
  // Each readable-or-not combination of one field, the rest agreeing.
  const fields = ['host', 'machineId', 'bootId', 'pidNamespace'] as const;
  for (const field of fields) {
    it(`${field}: the same value agrees`, () => {
      expect(ownerPlace(owner, reader)).toBe('here');
    });
    if (field !== 'host') {
      it(`${field}: unreadable on both sides agrees`, () => {
        expect(ownerPlace(without(owner, field), without(reader, field))).toBe(
          'here',
        );
      });
      it(`${field}: unreadable on the owner's side only is elsewhere`, () => {
        expect(ownerPlace(without(owner, field), reader)).toBe('elsewhere');
      });
      it(`${field}: unreadable on the reader's side only is elsewhere`, () => {
        expect(ownerPlace(owner, without(reader, field))).toBe('elsewhere');
      });
    }
    if (field !== 'bootId')
      it(`${field}: another value is elsewhere`, () => {
        expect(ownerPlace({ ...owner, [field]: 'other0' }, reader)).toBe(
          'elsewhere',
        );
      });
  }

  describe('an earlier boot of this machine has ended', () => {
    const earlier = { ...owner, bootId: EARLIER };
    it('when machine, host and both boots are known', () => {
      expect(ownerPlace(earlier, reader)).toBe('ended');
      // Its PID namespace went with it.
      expect(ownerPlace({ ...earlier, pidNamespace: '1' }, reader)).toBe(
        'ended',
      );
    });
    it.each([
      ['another machine id', { ...earlier, machineId: 'f'.repeat(32) }],
      ['another host', { ...earlier, host: 'other' }],
      ['no boot id of its own', without(earlier, 'bootId')],
    ])('not with %s', (_case, value) => {
      expect(ownerPlace(value, reader)).toBe('elsewhere');
    });
    it('not when the reader has no boot id or no machine id', () => {
      expect(ownerPlace(earlier, without(reader, 'bootId'))).toBe('elsewhere');
      expect(
        ownerPlace(without(earlier, 'machineId'), without(reader, 'machineId')),
      ).toBe('elsewhere');
    });
  });

  describe('a reader that cannot read its PID namespace', () => {
    const blind = without(reader, 'pidNamespace');
    const peer = without(owner, 'pidNamespace');
    const strict: PlaceOptions = { unreadableNamespaceIsForeign: true };
    it('sees a peer of the same kind as here by default', () => {
      expect(ownerPlace(peer, blind)).toBe('here');
    });
    it.runIf(process.platform === 'linux')(
      'sees every owner elsewhere when asked to',
      () => {
        expect(ownerPlace(peer, blind, strict)).toBe('elsewhere');
        expect(ownerPlace(owner, blind, strict)).toBe('elsewhere');
      },
    );
    it('asked to, still judges one that can read it', () => {
      expect(ownerPlace(owner, reader, strict)).toBe('here');
    });
  });
});

/** A system that answers as told, and says what it was asked. */
function probe(
  answer: {
    signal?: string;
    stat?: { state: string; startTime: string };
  },
  asked: string[] = [],
): OwnerProbe {
  return {
    signal: (pid) => {
      asked.push(`signal ${pid}`);
      if (answer.signal !== undefined)
        throw Object.assign(new Error(answer.signal), { code: answer.signal });
    },
    stat: async (pid) => {
      asked.push(`stat ${pid}`);
      return answer.stat;
    },
  };
}
const running = { state: 'S', startTime: '777' };

describe('whether an owner of this place may still be running', () => {
  it.each([
    ['its pid is free (ESRCH)', { signal: 'ESRCH' }, false],
    ['its pid answers and started when recorded', { stat: running }, true],
    [
      'its pid answers and started at another time',
      { stat: { state: 'S', startTime: '888' } },
      false,
    ],
    [
      'it is a zombie that nobody reaped',
      { stat: { ...running, state: 'Z' } },
      false,
    ],
    ['it is dead (X)', { stat: { ...running, state: 'X' } }, false],
    ['it is dead (x)', { stat: { ...running, state: 'x' } }, false],
    ['it is stopped', { stat: { ...running, state: 'T' } }, true],
    ['its stat cannot be read', {}, true],
    ['the signal fails another way (EINVAL)', { signal: 'EINVAL' }, true],
    [
      'another user has the pid (EPERM) and it started when recorded',
      { signal: 'EPERM', stat: running },
      true,
    ],
    [
      'another user has the pid (EPERM) and it started at another time',
      { signal: 'EPERM', stat: { state: 'S', startTime: '1' } },
      false,
    ],
    [
      'another user has the pid (EPERM) and its stat is hidden',
      { signal: 'EPERM' },
      true,
    ],
  ])('when %s: %s', async (_case, answer, alive) => {
    expect(await isOwnerAlive(owner, reader, probe(answer))).toBe(alive);
  });

  it('is alive when the record has no start time and the pid answers', async () => {
    expect(
      await isOwnerAlive(
        without(owner, 'startTime'),
        reader,
        probe({ stat: running }),
      ),
    ).toBe(true);
  });

  it('is gone as a zombie even without a recorded start time', async () => {
    expect(
      await isOwnerAlive(
        without(owner, 'startTime'),
        reader,
        probe({ stat: { ...running, state: 'Z' } }),
      ),
    ).toBe(false);
  });

  it("never compares a start time from a /proc that is not this namespace's", async () => {
    const asked: string[] = [];
    // The reader could not read its own start time: its /proc is not its own.
    const foreign = without(reader, 'startTime');
    expect(
      await isOwnerAlive(
        owner,
        foreign,
        probe({ stat: { state: 'S', startTime: '1' } }, asked),
      ),
    ).toBe(true);
    expect(asked).toEqual(['signal 4242']);
  });

  it('asks nothing of an owner of another place', async () => {
    const asked: string[] = [];
    const elsewhere = { ...owner, pidNamespace: '1' };
    expect(
      await isOwnerAlive(elsewhere, reader, probe({ signal: 'ESRCH' }, asked)),
    ).toBe(true);
    expect(asked).toEqual([]);
  });

  it('asks nothing of an owner of an earlier boot, and it is gone', async () => {
    const asked: string[] = [];
    expect(
      await isOwnerAlive(
        { ...owner, bootId: EARLIER },
        reader,
        probe({}, asked),
      ),
    ).toBe(false);
    expect(asked).toEqual([]);
  });

  describe('where the machine id cannot be read on either side', () => {
    // The #186 bug: an unreadable id taken for another machine made every
    // owner immortal. The machine id matters only to the earlier-boot rule.
    const blind = without(reader, 'machineId');
    const peer = without(owner, 'machineId');
    it('judges a gone pid gone', async () => {
      expect(await isOwnerAlive(peer, blind, probe({ signal: 'ESRCH' }))).toBe(
        false,
      );
    });
    it('judges a reused pid gone', async () => {
      expect(
        await isOwnerAlive(
          peer,
          blind,
          probe({ stat: { state: 'S', startTime: '1' } }),
        ),
      ).toBe(false);
    });
    it('judges a running pid alive', async () => {
      expect(await isOwnerAlive(peer, blind, probe({ stat: running }))).toBe(
        true,
      );
    });
    it('claims nothing about an earlier boot', async () => {
      expect(
        await isOwnerAlive(
          { ...peer, bootId: EARLIER },
          blind,
          probe({ signal: 'ESRCH' }),
        ),
      ).toBe(true);
    });
  });
});

describe('the name of an owner', () => {
  it('is 32 hex digits, the same for equal owners in every process', () => {
    expect(ownerKey(owner)).toMatch(/^[0-9a-f]{32}$/u);
    expect(ownerKey({ ...owner })).toBe(ownerKey(owner));
  });

  it.each([
    ['pid', { pid: 4243 }],
    ['host', { host: 'other' }],
    ['startTime', { startTime: '778' }],
    ['pidNamespace', { pidNamespace: '1' }],
    ['bootId', { bootId: EARLIER }],
    ['machineId', { machineId: 'f'.repeat(32) }],
  ])('differs when the %s does', (_field, change) => {
    expect(ownerKey({ ...owner, ...change })).not.toBe(ownerKey(owner));
  });

  it('tells an unreadable field from an empty-looking one', () => {
    expect(ownerKey(without(owner, 'bootId'))).not.toBe(
      ownerKey({ ...owner, bootId: '0' }),
    );
  });

  it('names the process in a message', () => {
    expect(describeProcessOwner(owner)).toBe('process 4242 on vm');
  });
});

describe('a record read back from disk', () => {
  it('keeps an owner whose fields are well formed', () => {
    expect(parseProcessOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
  });

  it.each([
    ['no pid', { host: 'vm' }],
    ['pid 0', { pid: 0, host: 'vm' }],
    ['a pid as text', { pid: '12', host: 'vm' }],
    ['no host', { pid: 12 }],
    [
      'a start time that is not a field',
      { pid: 12, host: 'vm', startTime: '1 2' },
    ],
    ['a namespace as a number', { pid: 12, host: 'vm', pidNamespace: 4 }],
    ['not an object', 'process 12'],
  ])('refuses %s', (_case, value) => {
    expect(parseProcessOwner(value)).toBeUndefined();
  });
});
