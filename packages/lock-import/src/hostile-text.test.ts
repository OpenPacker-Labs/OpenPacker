import { describe, expect, it } from 'vitest';
import { parsePnpmLock, parseRequirementsTxt, parseUvLock } from './index.js';

/**
 * A lock a cloned repository holds cannot shape the message of the error that
 * refuses it: a key, a name, a version or a line of it is repeated on one plain
 * line, so that a report that keeps the message's own line feeds shows no line
 * the lock added, and none holds a character a terminal acts on. Each case is
 * run with `x` and with hostile text in the value under test, and the two
 * messages have the same number of lines.
 */

/** Characters by code point, so no line of this file holds a separator or an override. */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
const HOSTILE = [
  '\nopm: ok imported 1 package@1\n  - pkg:npm/b@1: forged',
  chars(0x202e, 0x85),
  'ZZQ',
  chars(0x9b),
  '31m\rZZQ2',
  chars(0x2028),
  'ZZQ3',
  chars(0x2029, 0x07, 0x7f, 0xfeff, 0x200b, 0x1b),
  '[2K',
].join('');
/** The same text where a name must keep to what a key can hold. */
const IN_A_NAME = HOSTILE.replace(/[@/()]/gu, '');

const BREAK = new RegExp(`\\r\\n|[\\n\\r${chars(0x85, 0x2028, 0x2029)}]`, 'u');
/** A character class from inclusive ranges of code points, written as numbers. */
const classOf = (...ranges: [number, number][]): RegExp =>
  new RegExp(
    `[${ranges
      .map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`)
      .join('')}]`,
    'u',
  );
const NOT_TEXT = classOf(
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
);

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('the lock was accepted');
}

/** What is wrong with a message: a forged line, or a character that is not text. */
function violations(message: string): string[] {
  const found = message
    .split(BREAK)
    .filter((line) => /^(?:opm: ok|  - pkg:npm\/b@1|ZZQ)/u.test(line))
    .map((line) => `forged line: ${JSON.stringify(line)}`);
  if (NOT_TEXT.test(message)) found.push('not text');
  return found;
}

async function expectPlain(
  go: (text: string) => void,
  shown: string,
  hostileText = IN_A_NAME,
): Promise<void> {
  const innocent = messageOf(() => go('x'));
  expect(innocent).toContain(shown);
  const hostile = messageOf(() => go(hostileText));
  expect(violations(hostile)).toEqual([]);
  expect(hostile.split(BREAK)).toHaveLength(innocent.split(BREAK).length);
}

const pnpm = (packages: Record<string, unknown>, extra = {}) =>
  JSON.stringify({ lockfileVersion: '9.0', packages, ...extra });

describe('pnpm-lock.yaml, refused', () => {
  it('names a lockfileVersion it does not read on one line', async () => {
    await expectPlain(
      (text) => parsePnpmLock(JSON.stringify({ lockfileVersion: `8${text}` })),
      'lockfileVersion "8x"',
    );
  });

  it('names a key with a peer context on one line', async () => {
    await expectPlain(
      (text) => parsePnpmLock(pnpm({ [`a@1.0.0(${text})`]: {} })),
      'losslessly: a@1.0.0(x)',
    );
  });

  it.each([
    ['a name it cannot read', (text: string) => `a/${text}@1.0.0`, HOSTILE],
    ['a version it cannot read', (text: string) => `a@${text}`, IN_A_NAME],
  ])('names a key with %s on one line', async (_, key, hostileText) => {
    await expectPlain(
      (text) => parsePnpmLock(pnpm({ [key(text)]: {} })),
      'unsupported package key: ',
      hostileText,
    );
  });

  it.each([
    ['a package value that is not a mapping', 5, 'malformed package value for'],
    ['a resolution that is not a mapping', { resolution: 5 }, 'resolution for'],
    [
      'a tarball that is not text',
      { resolution: { tarball: 5 } },
      'resolution for',
    ],
    [
      'an integrity that is not text',
      { resolution: { integrity: 5 } },
      'resolution for',
    ],
  ])('names a key with %s on one line', async (_, value, shown) => {
    await expectPlain(
      (text) => parsePnpmLock(pnpm({ [`a${text}@1.0.0`]: value })),
      shown,
    );
  });

  it('names a package locked twice on one line', async () => {
    await expectPlain(
      (text) =>
        parsePnpmLock(pnpm({ [`a${text}@1.0.0`]: {}, [`a${text}@2.0.0`]: {} })),
      'multiple locked selections for ax',
    );
  });

  it('names a snapshot with no package on one line', async () => {
    await expectPlain(
      (text) =>
        parsePnpmLock(
          pnpm({ 'a@1.0.0': {} }, { snapshots: { [`b${text}@1.0.0`]: {} } }),
        ),
      'snapshot has no matching package: bx@1.0.0',
    );
  });
});

describe('requirements.txt, refused', () => {
  it('names an option line on one line', async () => {
    await expectPlain(
      (text) => parseRequirementsTxt(`-r reqs${text.replaceAll('\n', ' ')}`),
      'losslessly: "-r reqsx"',
    );
  });

  it('names a line that is not an exact pin on one line', async () => {
    await expectPlain(
      (text) => parseRequirementsTxt(`idna>=1${text.replaceAll('\n', ' ')}\n`),
      'is not an exact pin: "idna>=1x"',
    );
  });
});

describe('uv.lock, refused', () => {
  it('names a version it does not read on one line', async () => {
    await expectPlain(
      (text) =>
        parseUvLock(JSON.stringify({ version: `2${text}`, package: [] })),
      'received 2x',
    );
  });
});
