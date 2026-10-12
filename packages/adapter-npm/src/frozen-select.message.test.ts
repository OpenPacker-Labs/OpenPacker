import { describe, expect, it } from 'vitest';
import { classifyResolved } from './frozen-select.js';

/** Stands for a credential a lock holds in an address. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';

/**
 * A lock entry's `resolved` that is not a URL is named in the refusal, and it
 * was named whole: userinfo, query and fragment reached the terminal. It is
 * named as the other errors of `opm ci` name a source (`redactAddress`).
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
      'https://ho st/x',
    ],
    [
      'a bracket that is never closed',
      `https://u:${CANARY}@[::1/x?q=${CANARY}#${CANARY}`,
      'https://[::1/x',
    ],
    [
      'a port that is not a number',
      `https://u:${CANARY}@host:port/x?q=${CANARY}`,
      'https://host:port/x',
    ],
    [
      'a password that holds a /',
      `https://u:${CANARY}/y@ho st/z`,
      'https://ho st/z',
    ],
  ])('names it without its credentials: %s', (_, resolved, shown) => {
    const outcome = classifyResolved(entry(resolved));
    expect(outcome).toEqual({
      problem: `resolved ${JSON.stringify(shown)} is not a URL`,
    });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });
});
