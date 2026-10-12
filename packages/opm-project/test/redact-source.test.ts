import { describe, expect, it } from 'vitest';
import { redactSource } from '../src/frozen-store.js';

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
});
