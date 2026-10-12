import { describe, expect, it } from 'vitest';
import { classifyResolved } from './frozen-select.js';

/**
 * A lock's `resolved` is read by Node's URL parser further on (the policy's
 * facts, the fetch plan, the error lists), and the parser takes the square of
 * the length of a host of many non-ASCII labels. No DNS name is longer than 253
 * characters, so an entry whose source names a longer host is refused here,
 * before anything reads it.
 */
describe('classifyResolved, on the host of a source', () => {
  const entry = (resolved: string | undefined) => ({
    packageName: '@s/pkg',
    version: '1.2.3',
    resolved,
  });

  it.each([
    ['an https archive', 'https://', '/@s/pkg/-/pkg-1.2.3.tgz'],
    ['a git source', 'git+https://', '/o/r.git#abc'],
    ['an address with no slashes after the scheme', 'http:', '/x.tgz'],
    ['a path where a port goes', 'git+ssh://git@', ':o/r.git'],
    ['an address with a leading space', ' https://', '/x.tgz'],
  ])('refuses %s with a host no DNS name could be', (_, before, after) => {
    const host = 'ß.é.'.repeat(64).replace('é.ß', 'é\tß');
    expect(host.length).toBeGreaterThan(253);
    expect(classifyResolved(entry(`${before}${host}${after}`))).toEqual({
      problem:
        'resolved names a host longer than 253 characters, which no DNS name can be',
    });
  });

  it('reads a host of 253 characters, behind a long userinfo and before a long path', () => {
    const host = 'a'.repeat(253);
    expect(
      classifyResolved(
        entry(`https://${'u'.repeat(900)}@${host}/${'p'.repeat(900)}/x.tgz`),
      ),
    ).toEqual({ problem: 'resolved carries credentials in its URL' });
    expect(
      classifyResolved(entry(`https://${host}/@s/pkg/-/pkg-1.2.3.tgz`)),
    ).toEqual({ kind: 'registry' });
    expect(
      classifyResolved(entry(`https://${host}a/@s/pkg/-/pkg-1.2.3.tgz`)),
    ).toHaveProperty('problem');
  });

  it('refuses a host of many non-ASCII labels before a URL parser reads it', () => {
    const started = performance.now();
    const outcome = classifyResolved(
      entry(`https://${'ß.é.'.repeat(32768)}/x.tgz`),
    );
    expect(outcome).toHaveProperty('problem');
    // Node's parser takes about 4 seconds for this host.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
