import { describe, expect, it } from 'vitest';
import { redactSource } from '../src/frozen-store.js';

/** Stands for a credential an address holds. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';

/**
 * A lock entry's `resolved` is shown in two errors of `opm ci`: the list of
 * git and path sources it cannot install, and an archive that does not match
 * the digest the lock pins. What is shown is built from the URL parser's own
 * components (`redactAddress` in adapter-core): the scheme, the host and the
 * path, never userinfo, query or fragment, and never a slice of the text. An
 * address the parser refuses, or one in which an `@` after the authority may be
 * the end of a password, is the scheme and `[address withheld]`.
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
  ])('keeps the scheme, host and path of %s', (_, source, expected) => {
    expect(redactSource(source)).toBe(expected);
  });

  /**
   * Addresses `new URL` refuses (a colon and then a path where a port goes) are
   * not read at all. Nothing of the text is shown but a scheme it starts with:
   * a scp-like source costs its host and path, which is the price of never
   * cutting text.
   */
  it.each([
    [
      'a scp-like git address',
      `git+ssh://git@github.com:o/r.git?token=${CANARY}#frag`,
      'git+ssh:[address withheld]',
    ],
    [
      'a scp-like address with no scheme',
      `git@github.com:o/r.git#${CANARY}`,
      '[address withheld]',
    ],
    ['a relative path', '../local/pkg', '[address withheld]'],
    [
      'a password that holds an @',
      `git+ssh://deploy:${CANARY}@x@github.com:o/r.git`,
      'git+ssh:[address withheld]',
    ],
    [
      'a password that holds a ? and a #',
      `git+ssh://deploy:${CANARY}?x#y@github.com:o/r.git`,
      'git+ssh:[address withheld]',
    ],
    [
      'a host with a space in it',
      `https://u:${CANARY}@ho st/x?q=${CANARY}`,
      'https:[address withheld]',
    ],
  ])(
    'shows %s the parser refuses as the scheme and a fixed word',
    (_, source, expected) => {
      expect(redactSource(source)).toBe(expected);
      expect(redactSource(source)).not.toContain(CANARY);
    },
  );

  it.each([
    ['an https address', 'https://', 'ß.é.', '/x.tgz?token=x'],
    ['an address with no slashes after the scheme', 'http:', 'ß.é.', '/x'],
    ['an address with a leading space', ' https://u:p@', 'ß.é.', '/x'],
    ['an address with a [ inside its host', 'https://x[:', 'ß.é.', '/x'],
    [
      'an address with a [ inside its host and a path after',
      'https://x[',
      'ß.é.',
      '',
    ],
    [
      'a ws address with userinfo and a [ inside its host',
      'ws://u:p@x[:',
      '日.',
      '',
    ],
    ['a file address with an @ in its host', 'file://', 'ß.é.', '@x/y'],
    ['a file address with a colon in its host', 'file://x:', 'ß.é.', ''],
    ['a blob URL holding an address', 'blob:https://', 'ß.é.', '/x'],
    [
      'a blob URL holding an address with a [ in its host',
      'blob:http://x[:',
      'ß.é.',
      '',
    ],
  ])(
    'shows %s, whose host no DNS name could be, as [url] and unread',
    (_, before, unit, after) => {
      const started = performance.now();
      expect(redactSource(`${before}${unit.repeat(32768)}${after}`)).toBe(
        '[url]',
      );
      // Node's parser takes a second or more for this host, and `origin` of a
      // blob URL parses its path again.
      expect(performance.now() - started).toBeLessThan(500);
    },
  );

  it.each([
    ['a git source', 'git+https://u:p@', '/o/r.git#abc'],
    ['a custom scheme', 'x-custom://', '/y'],
  ])(
    'does not withhold %s with a long host: the parser reads it in linear time',
    (_, before, after) => {
      const started = performance.now();
      const shown = redactSource(`${before}${'ß.é.'.repeat(8192)}${after}`);
      expect(shown).not.toBe('[url]');
      expect(shown.startsWith(before.replace(/[^/]*@$/u, ''))).toBe(true);
      // 256 characters of the host, and how many there were.
      expect(shown.length).toBeLessThan(600);
      expect(shown).toContain('… (');
      expect(performance.now() - started).toBeLessThan(500);
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

  /**
   * A password may hold anything a person types, and `new URL` splits an
   * address at the first `/`, `?` or `#` it meets. Whatever the password holds,
   * and wherever in it, no part of it is printed.
   */
  describe('a password that holds the characters that end userinfo', () => {
    const PIECES = ['', '@', '?', '#', ':', '/'];
    const [C1, C2, C3] = [
      'vtok_dummy_marker_aaaaaaaa',
      'vtok_dummy_marker_bbbbbbbb',
      'vtok_dummy_marker_cccccccc',
    ] as const;
    const passwords = PIECES.flatMap((first) =>
      PIECES.map((second) => `${C1}${first}${C2}${second}${C3}`),
    );

    it.each([
      [
        'a scp-like git address, which the parser refuses',
        'git+ssh://',
        '@github.com:o/r.git',
      ],
      ['a git address with a path', 'git+https://', '@github.com/o/r.git'],
      ['an ssh address with a port', 'ssh://', '@github.com:22/o/r.git'],
      ['an https address', 'https://', '@registry.example/a/-/a-1.0.0.tgz'],
    ])('is not printed from %s', (_, before, after) => {
      for (const password of passwords) {
        const shown = redactSource(`${before}deploy:${password}${after}`);
        expect(shown, password).not.toContain('vtok_dummy_marker');
        expect(shown, password).not.toContain('deploy');
      }
    });

    it('is not printed when the parser reads the start of it as a port', () => {
      // `deploy:1234/<c>@github.com` is a host, a port and a path to the parser.
      for (const address of [
        `git+ssh://deploy:1234/${C1}@github.com:o/r.git`,
        `https://deploy:443/${C1}/${C2}@registry.example/a.tgz`,
        `https://deploy:443?${C1}@registry.example/a.tgz`,
        `git+ssh://deploy:22#${C1}@github.com:o/r.git`,
        `git+https://deploy:/${C1}/@example.test:8443/o/b.git`,
        `git+ssh://deploy:/${C1}/@github.com/o/r.git`,
        `https://deploy:123/${C1}/@host.example/x.tgz`,
      ]) {
        expect(redactSource(address), address).not.toContain(
          'vtok_dummy_marker',
        );
        expect(redactSource(address), address).not.toContain('deploy');
      }
    });

    it('is withheld from a user name, a query and a fragment too', () => {
      for (const address of [
        `git+ssh://${C1}:${C2}@github.com:o/r.git?x=${C3}`,
        `git+ssh://${C1}@github.com:o/r.git#${C2}`,
        `//deploy:${C1}/${C2}@github.com/o/r.git?x=${C3}`,
      ])
        expect(redactSource(address)).not.toContain('vtok_dummy_marker');
    });

    it('shows the host a person wrote, never the one after an @ of the text', () => {
      // An @ in the path, the query or the fragment is not userinfo to the
      // parser, and is not a host to anyone: the address is withheld, and a
      // host that comes after the @ is not shown in its place.
      for (const address of [
        'https://evil.example/x@registry.npmjs.org/p/-/p-1.0.0.tgz',
        'https://evil.example/p#x@registry.npmjs.org',
        'git+https://evil.example/a@github.com/o/r.git',
        `git+https://github.com/o/r.git?email=a@b.com&sig=${CANARY}`,
        `github:o/r#feature@${CANARY}`,
      ]) {
        const shown = redactSource(address);
        expect(shown, address).not.toContain('registry.npmjs.org');
        expect(shown, address).not.toContain('b.com');
        expect(shown, address).not.toContain(CANARY);
        expect(shown, address).toMatch(/\[address withheld\]$/u);
      }
    });
  });

  /**
   * An address with a scheme and no authority has an opaque path, which is where
   * userinfo stands when someone writes `user:password@host:path` or
   * `github:user:password@owner/repo`: the parser accepts it, with the user name
   * as the scheme. An `@` anywhere in it withholds it, and the scheme is not
   * shown unless opm reads it, since it may be the user name.
   */
  it.each([
    [
      'a hosted shorthand',
      `github:u:${CANARY}@o/r`,
      'github:[address withheld]',
    ],
    [
      'a hosted shorthand with a ? in the password',
      `github:u:${CANARY}?x@o/r#abc`,
      'github:[address withheld]',
    ],
    [
      'a scp-like address with a user name taken for a scheme',
      `user:${CANARY}@host:o/r`,
      '[address withheld]',
    ],
    [
      'a scp-like address under a git scheme and no slashes',
      `git+ssh:git:${CANARY}@github.com:o/r.git?token=${CANARY}`,
      'git+ssh:[address withheld]',
    ],
  ])('keeps no userinfo from %s', (_, source, expected) => {
    expect(redactSource(source)).toBe(expected);
    expect(redactSource(source)).not.toContain(CANARY);
  });

  it.each([
    ['an https address', 'blob:https://h/x', 'blob:https://h/x'],
    [
      'an https address with userinfo, a query and a fragment',
      `blob:https://u:${CANARY}@h/x?q=${CANARY}#${CANARY}`,
      'blob:https://h/x',
    ],
    [
      'an https address whose password holds a ?',
      `blob:https://u:${CANARY}?q@h/x`,
      'blob:[address withheld]',
    ],
    [
      'userinfo that the path takes for a scheme',
      `blob:u:${CANARY}@h/x`,
      'blob:[address withheld]',
    ],
    [
      'a blob in a blob',
      `blob:blob:https://u:${CANARY}@h/x`,
      'blob:blob:https://h/x',
    ],
    [
      'a path that is not an address',
      'blob:null/0c8d2f',
      'blob:[address withheld]',
    ],
  ])(
    'shows a blob URL holding %s as its address, redacted',
    (_, source, expected) => {
      expect(redactSource(source)).toBe(expected);
      expect(redactSource(source)).not.toContain(CANARY);
    },
  );

  /**
   * Whatever a password holds and wherever the address says its userinfo is,
   * no scheme that names a remote shows it: 10 schemes, three ways to begin
   * (`://`, `:/`, `:`), 13 forms of userinfo (a password that holds `@ ? # : /`,
   * a space, a newline, an escaped `@`, a user name alone), 7 hosts (one the
   * parser refuses, one it takes for a port) and 4 queries and fragments.
   * `file:` and `link:` are paths on this machine, which an `@` may be part of.
   */
  it('prints no password for any of 10,920 combinations of the parts of an address', () => {
    const schemes = [
      'git+https',
      'git+ssh',
      'git',
      'github',
      'gitlab',
      'http',
      'https',
      'ssh',
      'x',
      'blob:https',
    ];
    const begins = ['://', ':/', ':'];
    const userinfo = [
      `u:${CANARY}@`,
      `${CANARY}@`,
      `u:p@ss${CANARY}@`,
      `u:${CANARY}?q@`,
      `u:${CANARY}#f@`,
      `u:${CANARY}/q@`,
      `u:a/${CANARY}@`,
      `u:${CANARY}:q@`,
      `u:%40${CANARY}@`,
      `u:${CANARY}@x@`,
      `${CANARY}:@`,
      `u:${CANARY} sp@`,
      `u:\n${CANARY}@`,
    ];
    const hosts = [
      'github.com:o/r.git',
      'example.test/o/r.git',
      'o/r',
      'host',
      'ho st/p',
      '[::1/x',
      'h:abc/p',
    ];
    const tails = [
      '',
      `?token=${CANARY}`,
      `#${CANARY}`,
      `?t=${CANARY}#${CANARY}`,
    ];
    const leaks: string[] = [];
    let count = 0;
    for (const scheme of schemes)
      for (const begin of begins)
        for (const user of userinfo)
          for (const host of hosts)
            for (const tail of tails) {
              const address = `${scheme}${begin}${user}${host}${tail}`;
              count += 1;
              if (redactSource(address).includes(CANARY))
                leaks.push(JSON.stringify(address));
            }
    expect(leaks.slice(0, 5)).toEqual([]);
    expect(count).toBe(10_920);
  });

  it('does not parse the address in a blob URL again', () => {
    // `origin` of a blob URL parses its path: 5 seconds for this one.
    const started = performance.now();
    const shown = redactSource(
      `blob:https://${'a'.repeat(250)}.${'ß.é.'.repeat(60)}`,
    );
    expect(shown).toBe('[url]');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
