import { describe, expect, it } from 'vitest';
import {
  ECHO_TEXT_LIMIT,
  assertPackageIdentityMatchesRequest,
  echoed,
  parsePurl,
  parseSemver,
  parseSemverRange,
  parseVers,
  verifyNativeDigest,
} from './index.js';

/**
 * A message that repeats text from a document is one line. The text came from a
 * registry, and what writes the message (a terminal, a log, a report) cannot
 * tell the lines opm wrote from a line the registry added.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = '\nopm: ok installed everything';
const TITLE = `${ESC}]0;pwned${BEL}`;

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

async function messageOfAsync(run: () => Promise<boolean>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

/** No line break, no escape and no other control character. */
function expectOneLine(message: string): void {
  const control = [...message].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
  expect(control).toEqual([]);
}

describe('echoed', () => {
  it('leaves ordinary text as it is', () => {
    expect(echoed('pkg:npm/@scope/name@1.2.3')).toBe(
      'pkg:npm/@scope/name@1.2.3',
    );
    expect(echoed('naïve ключ 键')).toBe('naïve ключ 键');
  });

  it('is one line, and short', () => {
    expect(echoed(`a${FORGED}${TITLE}`)).toBe('aopm: ok installed everything');
    const long = echoed('k'.repeat(10_000));
    expect(long).toBe(`${'k'.repeat(ECHO_TEXT_LIMIT)}… (10000 characters)`);
  });
});

describe('what a shared parser says of the text it was given', () => {
  it.each([
    ['a percent escape', () => parsePurl(`pkg:npm/a%ZZ${FORGED}`)],
    ['a qualifier', () => parsePurl(`pkg:npm/a?bad${FORGED}`)],
    ['a repeated qualifier', () => parsePurl('pkg:npm/a?k%0Aopm=1&k%0Aopm=2')],
    ['a version', () => parseSemver(`1.0.0${FORGED}`)],
    ['a version with too many parts', () => parseSemver(`1.2.3.4.5${FORGED}`)],
    ['a version with a title', () => parseSemver(`1.0.0${TITLE}`)],
    [
      'a partial version',
      () => parseSemverRange(`1.a${TITLE}`, { scheme: 'npm', bare: 'caret' }),
    ],
    ['a VERS clause', () => parseVers(`vers:npm/>=1|${TITLE}`)],
    [
      'an identity that is not the one asked for',
      () =>
        assertPackageIdentityMatchesRequest('pkg:npm/a@1', {
          exactPurl: `pkg:npm/b@1${FORGED}`,
        }),
    ],
    [
      'no identity',
      () =>
        assertPackageIdentityMatchesRequest(`pkg:npm/a${FORGED}@1`, {
          exactPurl: '',
        }),
    ],
  ])('is one line: %s', (_, run) => {
    expectOneLine(messageOf(run));
  });

  it('is one line for a digest algorithm nobody supports', async () => {
    expectOneLine(
      await messageOfAsync(() =>
        verifyNativeDigest(new Uint8Array(1), `md5${FORGED}`, '00'),
      ),
    );
  });

  it('says the same of ordinary text as before', () => {
    expect(messageOf(() => parseSemver('1.0.0.0.0'))).toBe(
      'Invalid version: 1.0.0.0.0',
    );
    expect(messageOf(() => parsePurl('pkg:npm/a?bad'))).toBe(
      'Invalid qualifier: bad',
    );
    expect(messageOf(() => parseSemver(`${'9'.repeat(40)}.x`))).toBe(
      `Invalid version: ${'9'.repeat(40)}.x`,
    );
  });
});

describe('echoed, given what a document holds when it is not text', () => {
  /** A document is cast JSON, so a field the types call text may be anything. */
  function field(json: string): string {
    return JSON.parse(json).v;
  }

  it.each([
    ['a missing value', '{}', 'undefined'],
    ['null', '{"v":null}', 'null'],
    ['an array', '{"v":["x","y"]}', 'x,y'],
    ['a number', '{"v":5}', '5'],
    ['an object', '{"v":{}}', '[object Object]'],
  ])(
    'says %s as a template literal did, and does not throw',
    (_, json, said) => {
      expect(echoed(field(json))).toBe(said);
    },
  );
});
