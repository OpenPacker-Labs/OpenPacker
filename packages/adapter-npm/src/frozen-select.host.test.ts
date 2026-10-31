import { describe, expect, it } from 'vitest';
import { classifyResolved } from './frozen-select.js';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

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

  const REFUSED = {
    problem:
      'resolved names a host longer than 253 characters, which no DNS name can be',
  };
  const labels = 'ß.é.'.repeat(64);

  it.each([
    ['an https archive', 'https://', labels, '/@s/pkg/-/pkg-1.2.3.tgz'],
    ['an address with no slashes after the scheme', 'http:', labels, '/x.tgz'],
    ['an address with a leading space', ' https://', labels, '/x.tgz'],
    [
      'an address with a tab in its host',
      'https://',
      labels.replace('é.ß', 'é\tß'),
      '/x.tgz',
    ],
    ['an address with a [ inside its host', 'https://x[:', labels, '/x.tgz'],
    [
      'a ws address with userinfo and a [ inside its host',
      'ws://u:p@x[:',
      labels,
      '',
    ],
    ['a file address', 'file://', labels, '/x'],
    ['a file address with an @ in its host', 'file://', `${labels}@x`, '/x'],
    ['a file address with a colon in its host', 'file://x:', labels, ''],
    [
      'a file address in capitals with an @ in its host',
      'FILE://',
      `${labels}@x`,
      '',
    ],
  ])(
    'refuses %s, whose host no DNS name could be',
    (_, before, host, after) => {
      expect(classifyResolved(entry(`${before}${host}${after}`))).toEqual(
        REFUSED,
      );
    },
  );

  it.each([
    ['a git source', `git+https://${labels}/o/r.git#abc`, 'git'],
    ['a scp-like git source', `git+ssh://git@${labels}:o/r.git`, 'git'],
    ['a hosted shorthand', `github:${'a'.repeat(300)}/r`, 'git'],
    ['a file path of 300 characters', `file:${'a'.repeat(300)}`, 'path'],
    ['a file URL with an empty host', `file:///${'a'.repeat(300)}`, 'path'],
    ['a file URL with one slash', `file:/${'a'.repeat(300)}`, 'path'],
    ['a link', `link:${'a'.repeat(300)}/x`, 'path'],
    ['a relative path', `./${'a'.repeat(300)}`, 'path'],
  ])(
    'does not refuse %s: the parser reads its host in linear time',
    (_, resolved, kind) => {
      expect(classifyResolved(entry(resolved))).toEqual({ kind });
    },
  );

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

  it.each([
    ['https://', 'ß.é.'.repeat(32768), '/x.tgz'],
    ['https://x[:', 'ß.é.'.repeat(32768), '/x.tgz'],
    ['file://', 'ß.é.'.repeat(32768), '@x'],
    ['file://x:', 'ß.é.'.repeat(32768), ''],
  ])(
    'refuses a host of many non-ASCII labels before a URL parser reads it: %s',
    (before, host, after) => {
      const started = cpuMs();
      const outcome = classifyResolved(entry(`${before}${host}${after}`));
      expect(outcome).toEqual(REFUSED);
      // Node's parser takes about a second for the 131,072 characters of this
      // host (4 seconds for the first form, which it reads again and again).
      expect(cpuMs() - started).toBeLessThan(500);
    },
  );
});
