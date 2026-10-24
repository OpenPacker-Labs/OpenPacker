import { describe, expect, it } from 'vitest';
import { redactAddress } from './redact-address.js';

/**
 * A credential that is random std-base64 has a `/` in it, and a tool that
 * writes it raw into a URL's userinfo writes an address no URL parser reads as
 * a fetch with that credential (the authority ends at the first `/`). It is
 * still what ends up in a lock or an `opm.toml`, so what an error shows of it
 * is measured over a seeded corpus: a user name or a password of 24 or 40
 * random characters, written raw before the host of an unscoped registry
 * tarball. A credential that ends in `/` makes `@<host>/<name>/-/<file>` look
 * like the path of a scoped package's tarball, which is the one `@` the
 * redactor lets through.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const TAIL = 'registry.example.com/left-pad/-/left-pad-1.3.0.tgz';
/** What the output may say that is not the credential: its words are not a leak. */
const PUBLIC = `https://${TAIL} https:[address withheld]`.toLowerCase();
const CORPUS = 60_000;

/** mulberry32: the same corpus on every run and every machine. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(next: () => number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1)
    text += ALPHABET[Math.floor(next() * 64)];
  return text;
}

/** The first six characters of the credential, in any case, that the output repeats. */
function repeated(secret: string, output: string): string | undefined {
  const lower = secret.toLowerCase();
  const shown = output.toLowerCase();
  for (let at = 0; at + 6 <= lower.length; at += 1) {
    const run = lower.slice(at, at + 6);
    if (!PUBLIC.includes(run) && shown.includes(run)) return run;
  }
  return undefined;
}

describe('a random base64 credential written raw before a registry tarball URL', () => {
  it.each([
    ['a user name alone', 24, 4101, (secret: string) => secret],
    ['a user name alone', 40, 4102, (secret: string) => secret],
    ['the password of `ci`', 24, 4103, (secret: string) => `ci:${secret}`],
    ['the password of `ci`', 40, 4104, (secret: string) => `ci:${secret}`],
  ] as const)(
    'is never printed: %s, %d characters',
    (_form, length, seed, userinfo) => {
      const next = seeded(seed);
      const leaks: string[] = [];
      let endsInSlash = 0;
      for (let index = 0; index < CORPUS; index += 1) {
        const secret = token(next, length);
        if (secret.endsWith('/')) endsInSlash += 1;
        const address = `https://${userinfo(secret)}@${TAIL}`;
        const output = redactAddress(address);
        const run = repeated(secret, output);
        if (run !== undefined && leaks.length < 5)
          leaks.push(
            `${JSON.stringify(address)} -> ${JSON.stringify(output)} (repeats ${JSON.stringify(run)})`,
          );
      }
      // The shape that looks like a scoped tarball is in the corpus (1 in 64).
      expect(endsInSlash).toBeGreaterThan(700);
      expect(leaks).toEqual([]);
    },
  );

  it('still prints an address whose credential is written the way a tool can use it', () => {
    // A `/` written `%2F` is part of the userinfo, so the host is the registry.
    expect(redactAddress(`https://ci:ab%2Fcd%2F@${TAIL}`)).toBe(
      `https://${TAIL}`,
    );
    expect(redactAddress(`https://ab%2Fcd%2F@${TAIL}`)).toBe(`https://${TAIL}`);
  });
});

describe('the path of a scoped package tarball', () => {
  it('is printed with its scope', () => {
    expect(
      redactAddress('https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz'),
    ).toBe('https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz');
    expect(
      redactAddress('https://registry.example.com/@my_org-1/p/-/p-1.0.0.tgz'),
    ).toBe('https://registry.example.com/@my_org-1/p/-/p-1.0.0.tgz');
  });

  it('is withheld when the scope has a dot, which a host has', () => {
    // `@registry.example.com` as the segment before `name/-/file` is the end of
    // a credential that ends in `/` as often as it is a scope with a dot, and
    // a scope with a dot is the rarer: the lesser evil is to withhold it.
    for (const address of [
      'https://registry.example.com/@my.org/p/-/p-1.0.0.tgz',
      `https://deploy:1234/SECRET/@registry.example.com/p/-/p-1.0.0.tgz`,
      `https://SECRET/@registry.example.com/p/-/p-1.0.0.tgz`,
    ])
      expect(redactAddress(address)).toBe('https:[address withheld]');
  });
});
