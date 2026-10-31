import { describe, expect, it } from 'vitest';
import {
  makeCurrentOwner,
  ownerKey,
  ownerPlace,
  parseMachineId,
  parseProcessOwner,
  placeDigest,
  type OwnerReads,
  type ProcessOwner,
} from '../src/index.js';

/**
 * What a record says of an owner and how it is read back: the machine and the
 * boot as digests (X4), the host as text a terminal cannot misread (N3), and
 * this process named from reads that may fail for a while (N7).
 */

const BOOT = '9f7295d1-5100-478f-84e5-84ce9db4b369';
const MACHINE = '4c398f739c8447eb99d3fe100ad1b0fa';

/** An owner of one place whose ids are the raw ones an earlier opm wrote. */
const owner: ProcessOwner = {
  pid: 4242,
  host: 'vm',
  startTime: '777',
  pidNamespace: '4026531836',
  bootId: BOOT,
  machineId: MACHINE,
};

describe('a record read back from disk', () => {
  const digested: ProcessOwner = {
    ...owner,
    machineId: placeDigest('machine', MACHINE),
    bootId: placeDigest('boot', BOOT),
  };

  it('keeps an owner whose fields are well formed', () => {
    expect(parseProcessOwner(JSON.parse(JSON.stringify(digested)))).toEqual(
      digested,
    );
  });

  describe('the machine and the boot are kept as digests (X4)', () => {
    it('a digest is 32 hex digits keyed by what it names, and not the id', () => {
      expect(placeDigest('machine', MACHINE)).toMatch(/^d1-[0-9a-f]{32}$/u);
      expect(placeDigest('machine', MACHINE)).not.toContain(MACHINE);
      expect(placeDigest('boot', BOOT)).toMatch(/^d1-[0-9a-f]{32}$/u);
      expect(placeDigest('machine', MACHINE)).toBe(
        placeDigest('machine', MACHINE),
      );
      // The same text as a machine and as a boot is two digests.
      expect(placeDigest('boot', MACHINE)).not.toBe(
        placeDigest('machine', MACHINE),
      );
    });

    it('a field is read as it was written: nothing is rewritten into a digest (S2)', () => {
      // The raw ids, as another holder keeps them, are compared as given.
      expect(parseProcessOwner(JSON.parse(JSON.stringify(owner)))).toEqual(
        owner,
      );
    });

    it('a host-name digest in machineId and a boot without dashes survive a round trip, and judge as written (the lease of #187)', () => {
      const hostDigest = 'ab'.repeat(16);
      const boot = 'cd'.repeat(16);
      const reader: ProcessOwner = {
        pid: 100,
        host: 'h',
        startTime: '1',
        pidNamespace: '4026531836',
        machineId: hostDigest,
        bootId: boot,
      };
      const wire = { ...reader, pid: 99999999 };
      const parsed = parseProcessOwner(JSON.parse(JSON.stringify(wire)));
      expect(parsed).toEqual(wire);
      expect(parsed?.machineId).toBe(hostDigest);
      expect(parsed?.bootId).toBe(boot);
      expect(ownerPlace(parsed!, reader)).toBe('here');
      expect(ownerKey(parsed!)).toBe(ownerKey(wire));
    });

    it('a dashed boot id is kept as it is', () => {
      expect(parseProcessOwner({ pid: 5, host: 'h', bootId: BOOT })).toEqual({
        pid: 5,
        host: 'h',
        bootId: BOOT,
      });
    });

    it('an id of no known form is kept as it is', () => {
      expect(
        parseProcessOwner({ pid: 12, host: 'vm', machineId: 'abc-def' }),
      ).toEqual({ pid: 12, host: 'vm', machineId: 'abc-def' });
    });
  });

  describe('the host is text a terminal can show (N3)', () => {
    it.each([
      ['an escape sequence', 'vm\u001b]0;pwned\u0007'],
      ['a newline', 'vm\nopm: all is well'],
      ['a space', 'my vm'],
      ['a slash', 'a/b'],
      ['non-ASCII', 'vm\u202e'],
      ['nothing', ''],
      ['256 characters', 'a'.repeat(256)],
    ])('refuses %s', (_case, host) => {
      expect(parseProcessOwner({ pid: 12, host })).toBeUndefined();
    });
    it.each(['vm', 'ci-runner_12.example.com', 'A'.repeat(255)])(
      'keeps %s',
      (host) => {
        expect(parseProcessOwner({ pid: 12, host })).toEqual({ pid: 12, host });
      },
    );
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

/** The reads of a Linux process that answers as told. */
function reads(over: Partial<OwnerReads> = {}): OwnerReads {
  return {
    pid: 100,
    hostname: () => 'vm',
    stat: async () =>
      '100 (node) S 1 100 100 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 500 0 0',
    pidNamespace: async () => '4026531836',
    bootId: async () => BOOT,
    machineId: async () => MACHINE,
    ...over,
  };
}
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('this process as a record names it', () => {
  it('holds digests of the machine and the boot, never the ids (X4)', async () => {
    const self = await makeCurrentOwner(reads())();
    expect(self.machineId).toBe(placeDigest('machine', MACHINE));
    expect(self.bootId).toBe(placeDigest('boot', BOOT));
    expect(JSON.stringify(self)).not.toContain(MACHINE);
    expect(JSON.stringify(self)).not.toContain(BOOT);
    expect(self).toEqual(
      expect.objectContaining({
        pid: 100,
        host: 'vm',
        startTime: '500',
        pidNamespace: '4026531836',
      }),
    );
  });

  it('shows a host name a terminal cannot misread (N3)', async () => {
    const self = await makeCurrentOwner(
      reads({ hostname: () => 'vm\u001b]0;pwned\u0007 two' }),
    )();
    expect(self.host).toBe('vm__0_pwned__two');
    expect(parseProcessOwner(JSON.parse(JSON.stringify(self)))).toEqual(self);
  });

  it('keeps a host name the owner can be read back with, whatever it is (N3)', async () => {
    const empty = await makeCurrentOwner(reads({ hostname: () => '' }))();
    expect(parseProcessOwner(JSON.parse(JSON.stringify(empty)))).toEqual(empty);
    const long = await makeCurrentOwner(
      reads({ hostname: () => 'a'.repeat(400) }),
    )();
    expect(long.host).toHaveLength(255);
  });

  describe('is read again after a read that failed for a while (N7)', () => {
    it('a transient failure is not remembered', async () => {
      let tries = 0;
      const owner = makeCurrentOwner(
        reads({
          machineId: async () => {
            tries += 1;
            if (tries === 1) throw errno('EMFILE');
            return MACHINE;
          },
        }),
      );
      expect((await owner()).machineId).toBeUndefined();
      expect((await owner()).machineId).toBe(placeDigest('machine', MACHINE));
      expect(tries).toBe(2);
      // And once whole, it is kept.
      await owner();
      expect(tries).toBe(2);
    });

    it.each(['bootId', 'pidNamespace', 'stat'] as const)(
      'for the %s as well',
      async (field) => {
        let tries = 0;
        const owner = makeCurrentOwner(
          reads({
            [field]: async () => {
              tries += 1;
              if (tries === 1) throw errno('ENFILE');
              return reads()[field]();
            },
          }),
        );
        const first = await owner();
        const second = await owner();
        expect(first).not.toEqual(second);
        expect(tries).toBe(2);
      },
    );

    it.each(['ENOENT', 'EACCES', 'ENOTDIR'])(
      'a file that is not there (%s) is the answer, kept',
      async (code) => {
        let tries = 0;
        const owner = makeCurrentOwner(
          reads({
            machineId: async () => {
              tries += 1;
              throw errno(code);
            },
          }),
        );
        expect((await owner()).machineId).toBeUndefined();
        await owner();
        expect(tries).toBe(1);
      },
    );

    it('callers that ask together share one read', async () => {
      let tries = 0;
      const owner = makeCurrentOwner(
        reads({
          machineId: async () => {
            tries += 1;
            return MACHINE;
          },
        }),
      );
      await Promise.all([owner(), owner(), owner()]);
      expect(tries).toBe(1);
    });
  });
});

describe('the machine id the system gives', () => {
  it.each([
    ['32 lower-case hex digits', `${MACHINE}\n`, MACHINE],
    ['with spaces around', `  ${MACHINE}  `, MACHINE],
  ])('is taken: %s', (_what, text, id) => {
    expect(parseMachineId(text)).toBe(id);
  });

  it.each([
    ['upper case', MACHINE.toUpperCase()],
    ['31 digits', MACHINE.slice(1)],
    ['33 digits', `${MACHINE}0`],
    ['not hex', 'z'.repeat(32)],
    ['a UUID', '9f7295d1-5100-478f-84e5-84ce9db4b369'],
    ['empty', ''],
    ['uninitialized', 'uninitialized\n'],
  ])('is not taken: %s', (_what, text) => {
    expect(parseMachineId(text)).toBeUndefined();
  });
});
