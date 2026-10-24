import { describe, expect, it } from 'vitest';
import { classifyResolved } from './frozen-select.js';

/** Stands for a credential a lock holds in an address. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';

/**
 * A lock entry's `resolved` that is not a URL is named in the refusal, and it
 * was named whole: userinfo, query and fragment reached the terminal. It is
 * named as the other errors of `opm ci` name a source (`redactAddress`): an
 * address the parser refuses is its scheme and a fixed word.
 */
describe('classifyResolved, on an address that is not a URL', () => {
  const entry = (resolved: string) => ({
    packageName: 'p',
    version: '1.0.0',
    resolved,
  });

  it.each([
    [
      'a space in the host',
      `https://u:${CANARY}@ho st/x?q=${CANARY}#${CANARY}`,
      'https:[address withheld]',
    ],
    [
      'a bracket that is never closed',
      `https://u:${CANARY}@[::1/x?q=${CANARY}#${CANARY}`,
      'https:[address withheld]',
    ],
    [
      'a port that is not a number',
      `https://u:${CANARY}@host:port/x?q=${CANARY}`,
      'https:[address withheld]',
    ],
    [
      'a password that holds a /',
      `https://u:${CANARY}/y@ho st/z`,
      'https:[address withheld]',
    ],
  ])('names it without its credentials: %s', (_, resolved, shown) => {
    const outcome = classifyResolved(entry(resolved));
    expect(outcome).toEqual({
      problem: `resolved ${JSON.stringify(shown)} is not a URL`,
    });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });
});

/**
 * `user:password@host:path` is a valid URL whose scheme is the user name, and
 * "resolved uses <scheme>, not https" named it. The scheme is named as the other
 * errors name one (`shownScheme` in `@openpacker/adapter-core`): not when it may
 * be a user name.
 */
describe('classifyResolved, on a user name written before a colon', () => {
  const entry = (resolved: string) => ({
    packageName: 'p',
    version: '1.0.0',
    resolved,
  });
  /** Alphanumeric, so that it is a legal scheme. */
  const USER = 'vtokdummymarker0123456789abcdef';

  it.each([
    `${USER}:pw@github.com:o/r.git`,
    `${USER.toUpperCase()}:pw@github.com:o/r.git`,
    `${USER}:${USER}@host.example:o/r?x=${USER}#${USER}`,
  ])('does not name it as the scheme: %s', (resolved) => {
    const outcome = classifyResolved(entry(resolved));
    expect(outcome).toEqual({
      problem: 'resolved is [address withheld], not an https URL',
    });
    expect(JSON.stringify(outcome).toLowerCase()).not.toContain(USER);
  });

  it.each([
    ['ftp://u:pw@h.example/x.tgz', 'ftp:'],
    ['socks5://h.example:1080/x', 'socks5:'],
    ['abc123:o/r', 'abc123:'],
    ['npm:left-pad', 'npm:'],
  ])('names the scheme of %s', (resolved, scheme) => {
    expect(classifyResolved(entry(resolved))).toEqual({
      problem: `resolved uses ${scheme}, not https`,
    });
  });
});
