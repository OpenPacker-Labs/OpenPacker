import { describe, expect, it } from 'vitest';
import { redactSource } from '../src/frozen-store.js';

/** Stands for a credential an address holds. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';

/**
 * A lock entry's `resolved` is shown in two errors of `opm ci`: the list of
 * git and path sources it cannot install, and an archive that does not match
 * the digest the lock pins. It is shown as the same address with what must not
 * be printed taken out: userinfo, query and fragment. The scheme stays, so
 * that a person can tell a git source from an archive, as it does for an
 * `https:` address (`redactUrl`: origin and path). A scheme that has no origin
 * (`git+https:`, `git+ssh:`, `file:`) used to print as `null` and the path.
 */
describe('a source named in an error', () => {
  it.each([
    [
      'a git+https source',
      'git+https://example.test/b.git#0123456789abcdef0123456789abcdef01234567',
      'git+https://example.test/b.git',
    ],
    [
      'userinfo, query and fragment',
      'git+https://deploy:CANARY@example.test:8443/o/b.git?token=CANARY#abc',
      'git+https://example.test:8443/o/b.git',
    ],
    [
      'a git+ssh source',
      'git+ssh://git@github.com/o/r.git#abc',
      'git+ssh://github.com/o/r.git',
    ],
    [
      'a git: source',
      'git://github.com/o/r.git#abc',
      'git://github.com/o/r.git',
    ],
    ['a file: source', 'file:///srv/pkg?x=1#y', 'file:///srv/pkg'],
    ['a hosted shorthand', 'github:o/r#abc', 'github:o/r'],
    [
      'an https address, as before',
      'https://u:CANARY@github.com/o/r/tarball/abc?token=CANARY#f',
      'https://github.com/o/r/tarball/abc',
    ],
    [
      'an address a URL parser refuses, as before',
      'git+ssh://git@github.com:o/r.git',
      'git+ssh://github.com:o/r.git',
    ],
    ['a relative path, as before', '../local/pkg', '../local/pkg'],
  ])('keeps the scheme of %s', (_, source, expected) => {
    expect(redactSource(source)).toBe(expected);
  });

  /**
   * An address `new URL` refuses (a colon and then a path where a port goes) is
   * not parsed, so its userinfo, query and fragment are cut as text. Nothing
   * after the first `?` or `#` is printed, and userinfo ends at the last `@`
   * before the first `/`, so an `@`, `?` or `#` inside a password does not leave
   * the rest of it behind.
   */
  it.each([
    [
      'the query and fragment',
      `git+ssh://git@github.com:o/r.git?token=${CANARY}#frag`,
      'git+ssh://github.com:o/r.git',
    ],
    [
      'the fragment',
      `git+ssh://git@github.com:o/r.git#${CANARY}`,
      'git+ssh://github.com:o/r.git',
    ],
    [
      'the query of a relative path',
      `../local/pkg?token=${CANARY}`,
      '../local/pkg',
    ],
    [
      'the rest of a password that holds an @',
      `git+ssh://deploy:${CANARY}@x@github.com:o/r.git`,
      'git+ssh://github.com:o/r.git',
    ],
    [
      'a password that holds a ? and a #',
      `git+ssh://deploy:${CANARY}?x#y@github.com:o/r.git`,
      'git+ssh://github.com:o/r.git',
    ],
  ])(
    'withholds %s of an address a URL parser refuses',
    (_, source, expected) => {
      expect(redactSource(source)).toBe(expected);
      expect(redactSource(source)).not.toContain(CANARY);
    },
  );

  it.each([
    ['an https address', 'https://', '/x.tgz?token=x'],
    ['a git source', 'git+https://u:p@', '/o/r.git#abc'],
    ['an address with no slashes after the scheme', 'http:', '/x'],
    ['an address a URL parser refuses', 'git+ssh://git@', ':o/r.git?token=x'],
  ])(
    'shows %s with a host no DNS name could be as [url], unread',
    (_, before, after) => {
      const started = performance.now();
      expect(redactSource(`${before}${'ß.é.'.repeat(16384)}${after}`)).toBe(
        '[url]',
      );
      // Node's parser takes more than a second for this host.
      expect(performance.now() - started).toBeLessThan(2000);
    },
  );

  it('shows a host of 253 characters as it always did', () => {
    const host = 'a'.repeat(253);
    expect(redactSource(`git+https://u:p@${host}/o/r.git#abc`)).toBe(
      `git+https://${host}/o/r.git`,
    );
    expect(redactSource(`https://u:p@${host}/o/r.tgz?x#y`)).toBe(
      `https://${host}/o/r.tgz`,
    );
  });
});
