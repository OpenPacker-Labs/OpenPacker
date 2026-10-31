import { describe, expect, it } from 'vitest';
import { echoedValue } from './echo.js';
import { isAddress, redactText } from './redact-text.js';

/** Stands for a credential a value holds. */
const MARKER = 'vtok_dummy_marker_0123456789abcdef';
const ADDRESS = `https://user:${MARKER}@host.example/x.tgz?token=${MARKER}#${MARKER}`;

describe('a value of a document that may be an address', () => {
  it.each([
    [ADDRESS, 'https://host.example/x.tgz'],
    [`git+ssh://${MARKER}@github.com:o/r.git`, 'git+ssh:[address withheld]'],
    [`${MARKER}@github.com:o/r.git`, '[address withheld]'],
    // Behind what a terminal acts on, which the writer removes.
    [`\u001b[31m${ADDRESS}\u001b[0m\u0007`, 'https://host.example/x.tgz'],
    [`ht\u200btps://user:${MARKER}@host.example/x`, 'https://host.example/x'],
    // Inside a value that is not an address.
    [`left-pad/${ADDRESS}`, 'left-pad/https://host.example/x.tgz'],
    [`a ${ADDRESS} b`, 'a https://host.example/x.tgz b'],
    // An address that holds a space is read whole, as the parser reads it, and
    // an `@` after its authority withholds it.
    [`${ADDRESS} and ${ADDRESS}`, 'https:[address withheld]'],
    [
      `one ${ADDRESS} and ${ADDRESS}`,
      'one https://host.example/x.tgz and https://host.example/x.tgz',
    ],
    [`https://u:${MARKER}@ho st/z`, 'https:[address withheld]'],
    [`see https://u:${MARKER}@ho st/z`, 'see https://ho/ st/z'],
    [`ht\ttps://user:${MARKER}@host.example/x`, 'ht tps://host.example/x'],
  ])('%j is shown as %j', (value, shown) => {
    expect(redactText(value)).toBe(shown);
    expect(echoedValue(value)).toBe(shown);
    expect(echoedValue(value)).not.toContain(MARKER);
  });

  it.each([
    '1.2.3',
    '1.2.3-beta.4+build.5',
    '@scope/name',
    'left-pad',
    'node_modules/a/node_modules/@s/b',
    '../packages/shared',
    'C:\\packages\\shared',
    '://',
    'a:// ://',
    '',
  ])('returns %j as it is', (value) => {
    expect(redactText(value)).toBe(value);
    expect(echoedValue(value)).toBe(value);
  });

  it('leaves the hidden characters of a value that holds no address for the caller', () => {
    const value = 'a\u200bb\u202ec';
    expect(redactText(value)).toBe(value);
  });

  it('cuts after it has redacted, not before', () => {
    // Cut at 40 characters first, `https://user:123` is a host and a port.
    const value = `https://user:123${'4'.repeat(30)}@host.example/x`;
    expect(echoedValue(value, 40)).toBe('https://host.example/x');
    const long = `https://host.example/${'a'.repeat(300)}`;
    expect(echoedValue(long, 40)).toMatch(/… \(\d+ characters\)$/u);
  });

  it('knows an address from a path', () => {
    expect(isAddress('git+https://h/x')).toBe(true);
    expect(isAddress('user@host:path')).toBe(true);
    expect(isAddress('a:pw@host')).toBe(true);
    expect(isAddress('C:\\x')).toBe(false);
    expect(isAddress('./a:b')).toBe(false);
  });

  it('is linear', () => {
    const started = performance.now();
    redactText('a://'.repeat(250_000));
    redactText('a:// '.repeat(200_000));
    redactText('://'.repeat(300_000));
    redactText(`${'a'.repeat(1 << 20)}://x`);
    redactText(`${'é'.repeat(1 << 19)} ${ADDRESS}`);
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
