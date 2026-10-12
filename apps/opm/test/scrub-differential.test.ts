import { describe, expect, it } from 'vitest';
import { scrub } from '../src/scrub.js';
import { longRun, scattered, seeded, structured } from './scrub-corpus.js';
import { legacyScrub } from './scrub-legacy.js';
import { HOSTILE, build } from './scrub-hostile.js';
import { EXISTING_VECTORS } from './scrub-vectors.js';

/**
 * `scrub` was made linear without changing what it withholds. The first version
 * is frozen in `scrub-legacy.ts`; every input here must give the same text from
 * both, byte for byte. The inputs are short, because the first version is
 * quadratic, and drawn to hit what the expressions read.
 */

const NEL = '\u0085';
const KELVIN = '\u212a';
const LONG_S = '\u017f';

/** Fail with the input, not with a diff of two long outputs. */
function disagreements(inputs: Iterable<string>): string[] {
  const found: string[] = [];
  for (const input of inputs) {
    const expected = legacyScrub(input);
    const actual = scrub(input);
    if (actual !== expected && found.length < 5)
      found.push(
        `${JSON.stringify(input)}: first version ${JSON.stringify(expected)}, now ${JSON.stringify(actual)}`,
      );
  }
  return found;
}

describe('scrub gives the first version\u2019s text', () => {
  it('on every text the existing tests send through it', () => {
    expect(EXISTING_VECTORS.length).toBeGreaterThan(30);
    expect(disagreements(EXISTING_VECTORS)).toEqual([]);
  });

  it.each([
    [
      'a URL with userinfo',
      'GET https://user:pw@registry.example/a/b?token=abc#frag failed',
    ],
    ['an opaque origin', 'via socks5://u:p@proxy.example:1080/ then'],
    ['an unparsable URL', 'see http://[bad/x and https://ex ample/ end'],
    ['NEL inside a URL', `see https://${NEL}user:secret@host/p now`],
    ['NEL before a name', `x${NEL}password=hunter2`],
    [
      'a name with a prefix',
      'x-api-key: Bearer abcdef0123456789 and a-b-c-token=v',
    ],
    ['a name with a long s', `${LONG_S}ecret=v and tok${KELVIN}en=w`],
    ['a scheme with a Kelvin sign', `${KELVIN}://h/p and a${LONG_S}://h/q`],
    ['a scheme after an underscore', '_a://h/p and 1a://h/q and -a://h/r'],
    [
      'a scheme after a letter outside ASCII',
      'éa://h/p and 日a://h/q and 😀a://h/r',
    ],
    ['a URL with no body', 'http:// and https://) and ftp://'],
    ['a colon in a run', 'a:b://h/p and a::b://h/q'],
    ['two URLs in a row', 'http://a/b http://c/d,http://e/f)http://g/h'],
    ['a URL inside a URL', 'http://a/b?u=http://user:pw@c/d#x'],
    [
      'a credential inside a URL',
      'http://h/p?token=abc and token=http://u:p@h/',
    ],
    [
      'a credential after a bearer',
      'Authorization: Bearer abcdefgh Bearer abcdefgh',
    ],
    ['a long run of a- before a name', `${'a-'.repeat(50)}token=v`],
    ['a long run of a. before a URL', `${'a.'.repeat(50)}://h/p`],
    ['lone surrogates', '\ud800a://h/p \udc00token=v \ud800\ud800://x'],
    ['an astral character in a URL', 'http://h/\u{1f600}/p?q=\u{1f600}'],
    ['nothing', ''],
  ])('on %s', (_, input) => {
    expect(disagreements([input])).toEqual([]);
  });

  it('with one character put in each place an expression reads one', () => {
    // Every character of the basic plane, lone surrogates included, in the
    // places an expression reads one: before, inside and after a scheme, in and
    // around a name, in a separator, in a bearer token.
    const places = [
      (c: string) => `${c}a://h/p`,
      (c: string) => `a${c}://h/p`,
      (c: string) => `a://${c}h/p`,
      (c: string) => `a://h${c}p x`,
      (c: string) => `x${c}token=v`,
      (c: string) => `tok${c}en=v`,
      (c: string) => `token${c}=v`,
      (c: string) => `token=${c}v w`,
      (c: string) => `token=Bearer${c}abcdefgh`,
      (c: string) => `Bearer${c}abcdefgh`,
      (c: string) => `${c}Bearer abcdefgh`,
      (c: string) => `a-${c}b://h/p`,
    ];
    const everything = function* () {
      for (let code = 0; code <= 0xffff; code += 1) {
        const c = String.fromCharCode(code);
        for (const place of places) yield place(c);
      }
      // Beyond the basic plane: the first character of each plane, and a stride.
      for (let code = 0x10000; code <= 0x10ffff; code += 0x1fff) {
        const c = String.fromCodePoint(code);
        for (const place of places) yield place(c);
      }
    };
    expect(disagreements(everything())).toEqual([]);
  }, 120_000);

  it('on the texts of the linear-time test, at a size the first version can do', () => {
    // The timing test gives `expected` for a mebibyte; this checks that it is
    // also what the first version says, on 16 KiB of each text.
    for (const text of HOSTILE) {
      const { input, expected } = build(text, 16 * 1024);
      expect(legacyScrub(input), text.name).toBe(expected);
      expect(scrub(input), text.name).toBe(expected);
    }
  }, 120_000);

  it('on 3,000 strings that begin with a long run', () => {
    const random = seeded(0x77aa1);
    const inputs = function* () {
      for (let count = 0; count < 3000; count += 1) yield longRun(random);
    };
    expect(disagreements(inputs())).toEqual([]);
  }, 120_000);

  it('on 300,000 strings made of what it reads', () => {
    const random = seeded(0x5c2ab);
    let changed = 0;
    const found: string[] = [];
    for (let count = 0; count < 300_000; count += 1) {
      const input = structured(random);
      const expected = legacyScrub(input);
      const actual = scrub(input);
      if (expected !== input) changed += 1;
      if (actual !== expected && found.length < 5)
        found.push(
          `${JSON.stringify(input)}: first version ${JSON.stringify(expected)}, now ${JSON.stringify(actual)}`,
        );
    }
    expect(found).toEqual([]);
    // The corpus is worth something only if it makes the scrubber act.
    expect(changed).toBeGreaterThan(100_000);
  }, 300_000);

  it('on 100,000 strings of characters picked one at a time', () => {
    const random = seeded(0x1d4f7);
    let changed = 0;
    const inputs = function* () {
      for (let count = 0; count < 100_000; count += 1) {
        const input = scattered(random);
        if (legacyScrub(input) !== input) changed += 1;
        yield input;
      }
    };
    expect(disagreements(inputs())).toEqual([]);
    expect(changed).toBeGreaterThan(200);
  }, 300_000);
});
