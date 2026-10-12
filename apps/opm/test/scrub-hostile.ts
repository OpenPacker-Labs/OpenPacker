/**
 * The inputs of `scrub-linear.test.ts`: text a hostile registry could put in an
 * uncoded error's message, one mebibyte of it, meant to make a scrubber read
 * the same characters again and again. Every text ends with a URL with
 * userinfo, a password and a bearer token, so that a scrubber that is fast
 * because it gave up has to show it.
 *
 * This file is read by Node itself, in the child process of the test, so it
 * holds nothing a type stripper cannot erase and imports nothing.
 */

export const MIB = 1024 * 1024;

const WITNESS =
  ' see https://user:p@h.test/x?q=1 and password=hunter2 Bearer abcdefghijkl';
const WITHHELD =
  ' see https://h.test/x and password=[REDACTED] Bearer [REDACTED]';

export interface Hostile {
  /** What the test is called, and what the child is asked for. */
  name: string;
  /** What the text does to a scrubber that rescans, or to a URL parser. */
  against: string;
  /** The characters repeated to fill the mebibyte. */
  unit: string;
  /** What comes before them. */
  prefix?: string;
  /** What `scrub` makes of the prefix and the units, where it is not themselves. */
  becomes?: string;
}

export const HOSTILE: readonly Hostile[] = [
  {
    name: 'a-',
    against: 'every word boundary of one long run starts a scan of the run',
    unit: 'a-',
  },
  {
    name: 'a.',
    against: 'a scheme can hold a dot and a name cannot, so only the URL scan',
    unit: 'a.',
  },
  {
    name: '1-',
    against: 'a digit starts no scheme, so only the credential scan',
    unit: '1-',
  },
  {
    name: 'a-a.',
    against: 'both kinds of boundary in one run',
    unit: 'a-a.',
  },
  {
    name: 'runs of a- and a. cut by a: and a/',
    against: 'runs of 20,000 characters, each ended by a colon, then a slash',
    unit: `${'a-'.repeat(5000)}${'a.'.repeat(5000)}a:a/`,
  },
  {
    name: 'a- before ://',
    against:
      'a run that ends at a URL: the scan must come out right, not only fast',
    unit: `${'a-'.repeat(4000)}://x `,
  },
  {
    name: 'many short URLs',
    against: 'a scanner that copies the rest of the text for each URL it finds',
    unit: 'a://b ',
  },
  // A URL whose host no DNS name could be is withheld before the URL parser
  // reads it. Node's parser takes the square of the length of a host of many
  // non-ASCII labels (37 s for 524,295 characters of `ß.é.`); punycode labels
  // and dots of ASCII are not slow, and are here so that they stay withheld.
  {
    name: 'http:// then ß.é.',
    against: 'a host of non-ASCII labels, for the URL parser',
    prefix: 'http://',
    unit: 'ß.é.',
    becomes: '[url]',
  },
  {
    name: 'http:// then 日. (many dots)',
    against: 'a host of one-character non-ASCII labels, for the URL parser',
    prefix: 'http://',
    unit: '日.',
    becomes: '[url]',
  },
  {
    name: 'http:// then ǆ.',
    against:
      'a host of labels that change case when mapped, for the URL parser',
    prefix: 'http://',
    unit: 'ǆ.',
    becomes: '[url]',
  },
  {
    name: 'http:// then xn--zca.xn--9ca. (punycode labels)',
    against: 'a host of punycode labels, which the parser must decode',
    prefix: 'http://',
    unit: 'xn--zca.xn--9ca.',
    becomes: '[url]',
  },
  {
    name: 'http:// then dots',
    against: 'a host of nothing but dots',
    prefix: 'http://',
    unit: '.',
    becomes: '[url]',
  },
];

/**
 * The input of a text at a size, and the text `scrub` must give for it: what
 * the prefix and units become (themselves, unless `becomes` says otherwise;
 * none of the texts holds a URL with userinfo, a query or a fragment, a
 * credential or a bearer token) and the witness withheld.
 */
export function build(
  text: Hostile,
  size: number = MIB,
): { input: string; expected: string } {
  const prefix = text.prefix ?? '';
  const body =
    prefix +
    text.unit
      .repeat(Math.ceil(size / text.unit.length))
      .slice(0, size - WITNESS.length - prefix.length);
  return { input: body + WITNESS, expected: (text.becomes ?? body) + WITHHELD };
}
