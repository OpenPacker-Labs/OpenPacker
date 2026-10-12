/**
 * A seeded corpus of strings for `scrub-differential.test.ts`: URLs of every
 * kind the expressions read (schemes at and away from a word boundary, runs of
 * `a-a.b+c`, userinfo, hosts, percent-escapes, query and fragment, the
 * characters that end one), credential names with and without a prefix, every
 * separator, bearer and basic tokens, and the noise a message can hold (CR, LF,
 * tab, NEL, zero-width and bidirectional characters, non-ASCII letters, astral
 * characters, lone surrogates). The same seed gives the same strings.
 */

/** A fast seeded generator (mulberry32): a function giving [0, 1) each call. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A table written as one string, its entries divided by `|` (an empty entry is empty). */
function table(entries: string): string[] {
  return entries.split('|');
}

const K = 'K'; // the Kelvin sign, which a case-folding `k` also matches
const S = 'ſ'; // long s, which a case-folding `s` also matches
const NEL = '\u0085';

/** The pieces a scheme, a name or a run of word characters is made of. */
const WORD = table(
  `a|b|z|A|Z|x|h|s|k|0|1|9|-|-|.|.|+|_|é|${S}|${K}|ß|İ|ı|Ａ|日|😀|http|git|ssh|user|pass|a-|a.|1-|x-y.z+w`,
);
const SCHEMES = table(
  `http|https|HTTPS|Http|git+ssh|git+https|socks5|a|x|s3|file|ws|z+y.x-w|1|_|${S}|${K}|é|a-b|a.b|a+b|-a|.a|1a|_a|éa|`,
);
const JOINERS = table('://|://|://|://|:/|//|:|/|:///|::/');
const USERINFO = table(
  '||user:pass@|u:p@|tok@|@|a@b@|user%40x:p%3Aw@|:@|user:@|:p@|u:p@u2:p2@',
);
const HOSTS = table(
  'example.test|h|localhost|127.0.0.1|[::1]|[bad|ex ample|Ex%41mple.test|xn--e1afmkfd|é.test|日本.test|h:8080|h:99999|h:0x10|a..b|-|a_b.test|%zz|%|%00|',
);
const PATHS = table(
  `|/|/p|/a/b|/a%2Fb|/a b|/%41|/a?q=1|/a?token=abc|?q|?|#f|#|/..|/./x|/a;b|/a,b|/a'b|/a"b|/a<b|/a>b|/a)b|/a]b|/a(b|/a[b|/a\tb|/a\nb|/a${NEL}b|/日本|/😀`,
);
const NAMES = table(
  `token|Token|TOKEN|authorization|Authorization|secret|Secret|password|PASSWORD|passwd|api_key|api-key|apikey|API_KEY|Api-Key|npm_token|x-api-key|NPM_TOKEN|--password|access_token|_token|1token|éxtoken|${S}ecret|toKen|tokens|passwordd|authorisation|api key|api__key|tok${K}en`,
);
const SEPARATORS = table(
  `=|:| = | : |: |=  |\t=\t|:\n|=\r\n|==|::|:=|=:|| |.|-|${NEL}=|=${NEL}| = `,
);
const VALUES = table(
  `v|hunter2|abc123|abcdefgh|abcdefghijklmnop|dXNlcjpwYXNzd29yZA==|a.b-c_d~e+f/g=|"quoted"|'single'|(paren)|[bracket]|a,b|a;b|a)b|a]b|Bearer abcdefgh|Basic dXNlcjpw|Bearer|Basic|Bearer |bearer abcdefghij|BASIC abcdefghij|Bearer\tabcdefghij|Bearer\nabcdefghij|Bearer abcdefghij|Bearerabcdefgh|Bearer abc|Bearer abcdefg|`,
);
const BEARERS = table(
  `Bearer abcdefgh|bearer abcdefghijkl|BEARER abcdefgh|Basic dXNlcjpwYXNzd29yZA==|Basic  abcdefgh|Bearer\tabcdefgh|Bearer\nabcdefgh|Bearer abcdefg|Bearer abcdefgh!|Bearer ${S.repeat(8)}|xBearer abcdefgh|_Bearer abcdefgh|Bearer|Basic|Bearer `,
);
/** What can stand between two parts, and what ends a URL or a value. */
const GLUE = [
  ...table(
    ` | | |  |\t|\n|\r|\r\n|${NEL}| | | |　|﻿|​|\u001b|\u0000|,|;|'|"|)|]|(|[|<|>|{|}|\\|!|*|@|%|%41|%zz|&|$|\`|~|^|#|?|́|‮|é|${S}|${K}|日本|😀`,
  ),
  '|',
  // Written apart: next to each other the first two would be one astral character.
  '\ud83d',
  '\ude00',
  '\ud800',
  '\udc00',
];

function run(random: Random, longest: number): string {
  let text = '';
  for (let count = Math.floor(random() * longest); count > 0; count -= 1)
    text += pick(random, WORD);
  return text;
}

function urlPart(random: Random): string {
  const scheme = random() < 0.5 ? run(random, 8) : pick(random, SCHEMES);
  return (
    scheme +
    pick(random, JOINERS) +
    pick(random, USERINFO) +
    pick(random, HOSTS) +
    pick(random, PATHS)
  );
}

function credentialPart(random: Random): string {
  const prefix = random() < 0.4 ? run(random, 6) : '';
  return (
    prefix +
    pick(random, NAMES) +
    pick(random, SEPARATORS) +
    pick(random, VALUES)
  );
}

function part(random: Random): string {
  const kind = random();
  if (kind < 0.3) return urlPart(random);
  if (kind < 0.55) return credentialPart(random);
  if (kind < 0.65) return pick(random, BEARERS);
  if (kind < 0.8) return run(random, 12);
  return pick(random, GLUE);
}

/** One string made of up to eight parts, glued at random. */
export function structured(random: Random): string {
  let text = '';
  for (let count = 1 + Math.floor(random() * 8); count > 0; count -= 1) {
    text += part(random);
    if (random() < 0.6) text += pick(random, GLUE);
  }
  return text;
}

const BROAD = [
  ...`abcxzABCXZ019_-.+:/@?#%=,; \t\r\n'"()[]<>{}\\|!*&$\`~^é${S}${K}${NEL}  日😀`,
  '\ud800',
  '\udc00',
];
/**
 * Few characters, many of them the ones a URL or a name is made of: picked one
 * at a time they form `://` and a name often enough to matter.
 */
const DENSE = [...`aaA1--.+_::///  =@é${S}${K})\n`];

/** A string of characters picked one at a time: half from the broad set, half from the dense one. */
export function scattered(random: Random): string {
  const alphabet = random() < 0.5 ? BROAD : DENSE;
  let text = '';
  for (let count = Math.floor(random() * 48); count > 0; count -= 1)
    text += pick(random, alphabet);
  return text;
}

const AFTER_A_RUN = table(
  `://h/p|://|://u:p@h/p?q#f|:// x|:x|token=v| token=v|-token: Bearer abcdefgh| ||${NEL}://h|_://h|::/`,
);

/** A long run of word pieces (up to 1,500) with something a scheme or a name can end in after it. */
export function longRun(random: Random): string {
  return run(random, 1500) + pick(random, AFTER_A_RUN) + structured(random);
}

const HOST_UNITS = table('a|a|ß.é.|日.|ǆ.|ς.σ.|xn--zca.|.|a.|é|-|%41|a-');
const AUTHORITIES = table(
  `://|://|://|://u:p@|://${'z'.repeat(400)}@|://${'z'.repeat(400)}:${'9'.repeat(300)}@`,
);
const ENDS = table(':8080|/p|/p?q#f|?q|#f||/|:80/p?token=x');

/**
 * A URL whose host is between 240 and 269 characters, about a DNS name's
 * longest, of ASCII or of many non-ASCII labels, with userinfo and a port
 * that are not part of the host and are sometimes long.
 */
export function longHost(random: Random): string {
  const unit = pick(random, HOST_UNITS);
  const length = 240 + Math.floor(random() * 30);
  let host = '';
  while (host.length < length) host += unit;
  return (
    pick(
      random,
      SCHEMES.filter((scheme) => scheme !== ''),
    ) +
    pick(random, AUTHORITIES) +
    host.slice(0, length) +
    pick(random, ENDS)
  );
}

/** Structured text with one to three of those URLs in it. */
export function withLongHosts(random: Random): string {
  let text = structured(random);
  for (let count = 1 + Math.floor(random() * 3); count > 0; count -= 1)
    text +=
      pick(random, GLUE) +
      longHost(random) +
      pick(random, GLUE) +
      structured(random);
  return text;
}
