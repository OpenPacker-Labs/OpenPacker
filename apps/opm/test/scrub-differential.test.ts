import { describe, expect, it } from 'vitest';
import { scrub } from '../src/scrub.js';
import {
  longRun,
  scattered,
  seeded,
  structured,
  withLongHosts,
} from './scrub-corpus.js';
import { HOSTILE, build } from './scrub-hostile.js';
import { legacyScrub } from './scrub-legacy.js';
import {
  expectedScrub,
  holdsCutAnswer,
  holdsCutUrl,
  holdsOverlongHost,
  LONGEST_HOST,
} from './scrub-oracle.js';
import { EXISTING_VECTORS } from './scrub-vectors.js';

/**
 * Hands the event loop a turn. A test that computes for a minute without one
 * starves its vitest worker's answer to the runner (the worker gives up after
 * 60 s: "Timeout calling onTaskUpdate"), which a loaded machine reaches.
 */
const breathe = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * `scrub` was made linear without changing what it withholds. The first version
 * is frozen in `scrub-legacy.ts`, and `scrub` gives the same text, byte for
 * byte, on every input but three classes (`scrub-oracle.ts` says them
 * independently and precisely): a URL whose host, as Node's parser reads it, is
 * longer than 253 characters is withheld as `[url]` and never reaches the URL
 * parser; a URL is shown at most twice its own length and 600 characters,
 * because the parser writes a character outside ASCII as up to nine; and the
 * whole answer is cut at twice the length of the text, because the passes for a
 * credential name and a bearer token lengthen what they find. The inputs of the
 * first part hold few of the three, and are short because the first version is
 * quadratic; the second part is the first class and its edge.
 */

const NEL = '\u0085';
const KELVIN = '\u212a';
const LONG_S = '\u017f';

/** Whether the first version's text is expected to differ: one of the three classes. */
function documented(input: string): boolean {
  return (
    holdsOverlongHost(input) || holdsCutUrl(input) || holdsCutAnswer(input)
  );
}

/**
 * Fail with the input, not with a diff of two long outputs. `scrub` must give
 * the oracle's text, and the oracle must give the first version's text unless the
 * input is of one of the three classes.
 */
/**
 * Bounds that end a hang, not measures of speed: these property tests compute
 * for 17 to 60 s alone at a load of 30 to 60, and beside eight busy loops on
 * four cores the 40,000 long hosts went past 300 s and the 300,000 strings took
 * 169 s. The two longest get 15 minutes, the others 10.
 */
const LONG_MS = 600_000;
const LONGEST_MS = 900_000;

async function disagreements(inputs: Iterable<string>): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  for (const input of inputs) {
    if (++seen % 2000 === 0) await breathe();
    const expected = expectedScrub(input);
    const legacy = legacyScrub(input);
    const actual = scrub(input);
    if (actual !== expected && found.length < 5)
      found.push(
        `${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, now ${JSON.stringify(actual)}`,
      );
    if (legacy !== expected && !documented(input) && found.length < 5)
      found.push(
        `${JSON.stringify(input)}: first version ${JSON.stringify(legacy)}, expected ${JSON.stringify(expected)}`,
      );
  }
  return found;
}

describe('scrub gives the first version\u2019s text', () => {
  it('on every text the existing tests send through it', async () => {
    expect(EXISTING_VECTORS.length).toBeGreaterThan(30);
    expect(await disagreements(EXISTING_VECTORS)).toEqual([]);
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
  ])('on %s', async (_, input) => {
    expect(await disagreements([input])).toEqual([]);
  });

  it(
    'with one character put in each place an expression reads one',
    async () => {
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
      expect(await disagreements(everything())).toEqual([]);
    },
    LONG_MS,
  );

  it(
    'on the texts of the linear-time test, at a size the first version can do',
    async () => {
      // The timing test gives `expected` for a mebibyte; this checks it on 16 KiB
      // of each text. The texts that are one long host are the class: the oracle
      // gives `[url]` for them and the first version prints the URL.
      for (const text of HOSTILE) {
        await breathe();
        const { input, expected } = build(text, 16 * 1024);
        expect(scrub(input), text.name).toBe(expected);
        expect(expectedScrub(input), text.name).toBe(expected);
        if (text.becomes === undefined && text.unitBecomes === undefined)
          expect(legacyScrub(input), text.name).toBe(expected);
      }
    },
    LONG_MS,
  );

  it(
    'on 3,000 strings that begin with a long run',
    async () => {
      const random = seeded(0x77aa1);
      const inputs = function* () {
        for (let count = 0; count < 3000; count += 1) yield longRun(random);
      };
      expect(await disagreements(inputs())).toEqual([]);
    },
    LONG_MS,
  );

  it(
    'on 300,000 strings made of what it reads',
    async () => {
      const random = seeded(0x5c2ab);
      let changed = 0;
      const found: string[] = [];
      for (let count = 0; count < 300_000; count += 1) {
        if (count % 2000 === 0) await breathe();
        const input = structured(random);
        const legacy = legacyScrub(input);
        const expected = expectedScrub(input);
        const actual = scrub(input);
        if (legacy !== input) changed += 1;
        if (expected !== legacy && !documented(input) && found.length < 5)
          found.push(
            `the oracle differs from the first version on ${JSON.stringify(input)}`,
          );
        if (actual !== expected && found.length < 5)
          found.push(
            `${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, now ${JSON.stringify(actual)}`,
          );
      }
      expect(found).toEqual([]);
      // The corpus is worth something only if it makes the scrubber act.
      expect(changed).toBeGreaterThan(100_000);
    },
    LONGEST_MS,
  );

  it(
    'on 100,000 strings of characters picked one at a time',
    async () => {
      const random = seeded(0x1d4f7);
      let changed = 0;
      const inputs = function* () {
        for (let count = 0; count < 100_000; count += 1) {
          const input = scattered(random);
          if (legacyScrub(input) !== input) changed += 1;
          yield input;
        }
      };
      expect(await disagreements(inputs())).toEqual([]);
      expect(changed).toBeGreaterThan(200);
    },
    LONG_MS,
  );
});

describe('scrub withholds a URL whose host no DNS name could be', () => {
  const ascii = (length: number) => 'a'.repeat(length);
  const labels = (length: number) => 'ß.é.'.repeat(64).slice(0, length);
  const L = LONGEST_HOST;

  it.each([
    ['253 ASCII characters', `http://${ascii(L)}/p`, false],
    ['254 ASCII characters', `http://${ascii(L + 1)}/p`, true],
    ['253 characters of non-ASCII labels', `http://${labels(L)}/p`, false],
    ['254 characters of non-ASCII labels', `http://${labels(L + 1)}/p`, true],
    [
      '254 characters in a scheme the parser reads in linear time',
      `x://${ascii(L + 1)}/p`,
      false,
    ],
    [
      'a long scp-like git address, which has an opaque host',
      `git+ssh://git@${ascii(300)}:o/r.git`,
      false,
    ],
    [
      '254 characters with a port after them',
      `https://${ascii(L + 1)}:8443/p`,
      true,
    ],
    [
      '253 characters with a long port after them',
      `https://${ascii(L)}:${'9'.repeat(400)}/p`,
      false,
    ],
    [
      '253 characters behind a long userinfo',
      `https://${'u'.repeat(900)}:${'p'.repeat(900)}@${ascii(L)}/p`,
      false,
    ],
    [
      '254 characters behind a short userinfo',
      `https://u:p@${ascii(L + 1)}/p`,
      true,
    ],
    ['254 characters after two @', `https://a@b@${ascii(L + 1)}/p`, true],
    [
      '253 characters with a long path, query and fragment',
      `https://${ascii(L)}/${'p'.repeat(900)}?${'q'.repeat(900)}#${'f'.repeat(900)}`,
      false,
    ],
    ['254 characters ended by a query', `https://${ascii(L + 1)}?q`, true],
    ['254 characters ended by a fragment', `https://${ascii(L + 1)}#f`, true],
    [
      'a bracketed host after a long userinfo (the URL pattern ends at the ])',
      `https://${'u'.repeat(900)}@[::1]:80/p`,
      false,
    ],
    ['no path after a host of 254', `http://${ascii(L + 1)}`, true],
    // A [ inside the host switches the port colon off: the host runs on, and
    // Node's parser reads it past the authority, to a `#` or the end.
    ['a [ inside the host, 253', `http://x[:${ascii(L - 3)}#p`, false],
    ['a [ inside the host, 254', `http://x[:${ascii(L - 2)}#p`, true],
    [
      'a [ inside the host, then a path, 253',
      `http://x[${ascii(L - 4)}/p`,
      false,
    ],
    [
      'a [ inside the host, then a path, 254',
      `http://x[${ascii(L - 3)}/p`,
      true,
    ],
    [
      'a [ inside the host, then a query, over the limit',
      `https://x[${ascii(100)}?${ascii(200)}`,
      true,
    ],
    ['a [ inside the host, ws, 254', `ws://u:p@x[:${ascii(L - 2)}`, true],
    [
      'a [ inside the host with ß.é. labels',
      `https://x[:${'ß.é.'.repeat(200)}`,
      true,
    ],
    [
      'a [ inside the host with escaped labels',
      `https://x[:${'%C3%A9.'.repeat(100)}`,
      true,
    ],
    // A file host has no userinfo and no port: the whole authority is the host.
    ['a file host, @ at the end, 253', `file://${ascii(L - 2)}@x/p`, false],
    ['a file host, @ at the end, 254', `file://${ascii(L - 1)}@x/p`, true],
    ['a file host, a colon first, 254', `file://:${ascii(L)}/p`, true],
    [
      'a file host, a colon after a name, 254',
      `file://x:${ascii(L - 1)}`,
      true,
    ],
    ['a file host, userinfo-like, 254', `file://u:${ascii(L - 1)}@h`, true],
    ['an empty file host and a long path', `file:///${ascii(300)}`, false],
    [
      'a file URL with its path in the host slot of one slash',
      `file:/${ascii(300)}`,
      false,
    ],
    ['a file URL with no slash at all', `file:${ascii(300)}`, false],
  ])('with %s', (_, address, withheld) => {
    const text = `see ${address} end`;
    const found = withheld ? 'see [url] end' : expectedScrub(text);
    expect(holdsOverlongHost(text)).toBe(withheld);
    expect(scrub(text)).toBe(found);
    // The oracle is the first version's text unless the URL, or the answer, is cut.
    if (!withheld && !holdsCutUrl(text) && !holdsCutAnswer(text))
      expect(found).toBe(legacyScrub(text));
  });

  it('does not print the userinfo or the host of one it withholds', () => {
    const secret = 'vtok_dummy_marker_0123456789abcdef';
    const host = 'ß.é.'.repeat(80);
    const text = `GET http://deploy:${secret}@${host}/p?token=${secret} failed`;
    expect(scrub(text)).toBe('GET [url] failed');
  });

  it(
    'on 40,000 strings that hold a URL with a host near the longest there is',
    async () => {
      const random = seeded(0x2f7c1);
      const found: string[] = [];
      let withheld = 0;
      let kept = 0;
      let overlong = 0;
      for (let count = 0; count < 40_000; count += 1) {
        if (count % 100 === 0) await breathe();
        const input = withLongHosts(random);
        const expected = expectedScrub(input);
        const legacy = legacyScrub(input);
        if (scrub(input) !== expected && found.length < 5)
          found.push(
            `${JSON.stringify(input)}: expected ${JSON.stringify(expected)}`,
          );
        // The difference from the first version is the class, and only the class.
        if (holdsOverlongHost(input)) overlong += 1;
        if (expected !== legacy) {
          withheld += 1;
          if (!documented(input) && found.length < 5)
            found.push(
              `${JSON.stringify(input)}: differs without an overlong host or a cut URL`,
            );
        } else kept += 1;
      }
      expect(found).toEqual([]);
      // Both sides of the edge are exercised: strings the first version printed
      // and this withholds, strings it left alone, and strings with an overlong
      // host that the first version already wrote as `[url]`, because the parser
      // refuses a host with a `[` or an `@` in it.
      expect(withheld).toBeGreaterThan(3000);
      expect(kept).toBeGreaterThan(5000);
      expect(overlong).toBeGreaterThan(10_000);
    },
    LONGEST_MS,
  );
});
