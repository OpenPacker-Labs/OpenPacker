import { describe, expect, it } from 'vitest';
import { redactAddress, shownScheme } from './redact-address.js';

/**
 * `user:password@host:path` is how a user name comes before a colon in a text
 * with no `//`, and it is also a valid URL whose scheme is the user name. An
 * error that prints the scheme of such a value prints the user name. A scheme
 * is printed only when it is one opm reads, or when `//` follows it, where
 * what stands before the colon is a scheme and the user name comes after.
 */

/** Alphanumeric, so it is a legal scheme (an underscore would not be). */
const USER = 'vtokdummymarker0123456789abcdef';

describe('a user name before a colon is never printed as the scheme', () => {
  it.each([
    // The parser accepts these, and reads the user name as the scheme.
    `${USER}:pw@github.com:o/r.git`,
    `${USER.toUpperCase()}:pw@github.com:o/r.git`,
    `${USER}:@github.com:o/r.git`,
    `${USER}:a:b@host:o/r?x#y`,
    `${USER}:${USER}@github.com:o/r.git`,
    // The parser refuses these, and the text still starts like a scheme.
    `${USER}:pw@ho st:o/r`,
    `${USER}:pw@[::1:o/r`,
    `${USER}:pw/x@ho st`,
    // Inside a blob URL.
    `blob:${USER}:pw@github.com:o/r.git`,
  ])('%s', (address) => {
    const output = redactAddress(address);
    expect(output.toLowerCase()).not.toContain(USER);
    expect(output).toMatch(/(?:^|:)\[address withheld\]$/u);
  });

  it('is withheld with no scheme at all', () => {
    expect(redactAddress(`${USER}:pw@github.com:o/r.git`)).toBe(
      '[address withheld]',
    );
    expect(redactAddress(`${USER}:pw@ho st:o/r`)).toBe('[address withheld]');
    expect(redactAddress('user:pw@host:o/r')).toBe('[address withheld]');
    expect(redactAddress(`blob:${USER}:pw@github.com:o/r.git`)).toBe(
      'blob:[address withheld]',
    );
  });

  it('is told by shownScheme, which the lock reader asks', () => {
    expect(shownScheme(new URL(`${USER}:pw@github.com:o/r.git`))).toBe(
      undefined,
    );
    expect(shownScheme(new URL('ftp://u:p@h/x.tgz'))).toBe('ftp:');
    expect(shownScheme(new URL('socks5://h:1080'))).toBe('socks5:');
    expect(shownScheme(new URL('npm:left-pad'))).toBe('npm:');
  });
});

describe('what is printed as a scheme', () => {
  it.each([
    // A scheme opm reads, with no authority and an `@`.
    ['github:u:pw@o/r', 'github:[address withheld]'],
    ['github:o/r#feature@1', 'github:[address withheld]'],
    ['gitlab:o/r#a@b', 'gitlab:[address withheld]'],
    ['git+ssh:git@github.com:o/r.git', 'git+ssh:[address withheld]'],
    ['git+https:u:pw@h/o/r.git', 'git+https:[address withheld]'],
    // `//` follows: what is before the colon is a scheme, as it always was.
    ['https://u:p@ho st/x', 'https:[address withheld]'],
    ['x://u:p@ho st/x', 'x:[address withheld]'],
    ['git+ssh://git@github.com:o/r.git', 'git+ssh:[address withheld]'],
    ['ssh://u:p@h/p?x#y', 'ssh://h/p'],
    ['ssh://git@github.com/o/r.git', 'ssh://github.com/o/r.git'],
    ['git+https://deploy:pw@h/o/r.git', 'git+https://h/o/r.git'],
    ['socks5://u:p@h:1080/x', 'socks5://h:1080/x'],
    ['abc://host/a@b', 'abc:[address withheld]'],
    ['x:///srv/a@b', 'x:[address withheld]'],
    // No `@`, so there is no password for the scheme to be the user of.
    ['abc123:o/r', 'abc123:o/r'],
    ['npm:left-pad', 'npm:left-pad'],
    ['a:/.///b', 'a:/.///b'],
    // A path on this machine, where an `@` is a character.
    ['file:///srv/@s/pkg?x=1', 'file:///srv/@s/pkg'],
    ['link:../pkg@1.0.0', 'link:../pkg@1.0.0'],
  ])('%s -> %s', (address, shown) => {
    expect(redactAddress(address)).toBe(shown);
  });
});

describe('how long a scheme is printed', () => {
  const scheme = (length: number) => 'a'.repeat(length);

  it('prints a scheme of 32 characters and withholds one of 33', () => {
    expect(redactAddress(`${scheme(32)}://h/x`)).toBe(`${scheme(32)}://h/x`);
    expect(redactAddress(`${scheme(33)}://h/x`)).toBe('[address withheld]');
    expect(redactAddress(`${scheme(33)}:u:p@h:o/r`)).toBe('[address withheld]');
    expect(redactAddress(`blob:${scheme(33)}://h/x`)).toBe(
      'blob:[address withheld]',
    );
    // `git+https` and the rest of the schemes people write are far shorter.
    expect(redactAddress('git+https://github.com/o/r.git')).toBe(
      'git+https://github.com/o/r.git',
    );
  });

  it.each([
    ['an authority', (s: string) => `${s}://h/x`],
    ['no authority', (s: string) => `${s}:o/r`],
    ['an opaque path with an @', (s: string) => `${s}:u:p@h:o/r`],
    ['a refused host', (s: string) => `${s}://u:p@ho st/x`],
    ['a blob', (s: string) => `blob:${s}://h/x`],
  ])('prints almost nothing of a scheme of 1 MiB: %s', (_, build) => {
    const started = performance.now();
    const shown = redactAddress(build(scheme(1 << 20)));
    expect(shown.length).toBeLessThan(64);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
