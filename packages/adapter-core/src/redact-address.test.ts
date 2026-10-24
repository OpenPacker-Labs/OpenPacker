import { describe, expect, it } from 'vitest';
import { redactAddress } from './redact-address.js';

/**
 * What `redactAddress` prints is built from the URL parser's own components,
 * never from a slice of the text, so a marker put anywhere in an address can
 * come out only where the parser put it in the host or the path. This test
 * holds that over a grid: a marker in the user name, in the password (with every
 * pair of the characters that end userinfo and the shapes the parser reads as a
 * port and a path), in the query, in the fragment, in the path, and, for
 * addresses the parser refuses, in every position of a few odd forms.
 */

const MARKER = 'vtok_dummy_marker_0123456789abcdef';
const SPECIAL = ['https://', 'http://', 'ftp://', 'ws://'];
const REMOTE = ['git+https://', 'git+ssh://', 'ssh://', 'x://'];
const OPAQUE = ['github:', 'user:', 'x:', 'git+ssh:', 'git+https:/'];
const BLOBS = ['blob:https://', 'blob:blob:https://', 'blob:git+ssh://'];
const LOCAL = ['file://', 'file:///srv/', 'link:'];
const ENDERS = ['@', '?', '#', ':', '/', '%'];
const HOSTS = ['host.example', 'host.example:8443', 'github.com:o', 'deploy'];
const TAILS = [
  '',
  '/o/r.git',
  '/p/-/p-1.0.0.tgz',
  '/@scope/p/-/p-1.0.0.tgz',
  '/o/r.git?x=1#ref',
];

/** Every password form: the marker alone, framed by every pair, and the port-like ones. */
function passwords(): string[] {
  const variants = new Set<string>([MARKER, `1234/${MARKER}`, `/${MARKER}/`]);
  for (const first of ENDERS)
    for (const second of ENDERS) {
      variants.add(`${first}${second}${MARKER}`);
      variants.add(`${first}${MARKER}${second}`);
      variants.add(`${MARKER}${first}${second}`);
    }
  for (const lead of ['1234', '443', '12', '']) {
    for (const mark of ENDERS) {
      variants.add(`${lead}${mark}${MARKER}`);
      variants.add(`${lead}${mark}${MARKER}${mark}`);
      variants.add(`${lead}${mark}${MARKER}/`);
    }
  }
  return [...variants];
}

/** Addresses with the marker in the user name, the password, the query or the fragment. */
function* addresses(): Generator<string> {
  const prefixes = [...SPECIAL, ...REMOTE, ...BLOBS];
  for (const prefix of prefixes)
    for (const host of HOSTS)
      for (const tail of TAILS) {
        yield `${prefix}${MARKER}@${host}${tail}`;
        yield `${prefix}${MARKER}:@${host}${tail}`;
        yield `${prefix}u:${MARKER}@${host}${tail}`;
        yield `${prefix}${host}${tail}?token=${MARKER}`;
        yield `${prefix}${host}${tail}#${MARKER}`;
        yield `${prefix}${host}${tail}?a=b@c#${MARKER}`;
        if (!tail.includes('@')) yield `${prefix}${host}/${MARKER}${tail}`;
        // A password that ends in a `/`, followed by a host with no dot and a
        // tarball path, is a scoped package's tarball path to anyone: the one
        // case left out here, and pinned by its own test below. A host with a dot
        // is not a scope, and is in the grid.
        if (!(tail === '/p/-/p-1.0.0.tgz' && host === 'deploy'))
          for (const password of passwords())
            yield `${prefix}deploy:${password}@${host}${tail}`;
      }
  for (const prefix of [...OPAQUE, ...LOCAL])
    for (const password of passwords()) {
      yield `${prefix}u:${password}@o/r`;
      yield `${prefix}u:${password}@github.com:o/r.git`;
      yield `${prefix}${MARKER}@o/r`;
      yield `${prefix}o/r?${MARKER}`;
      yield `${prefix}o/r#${MARKER}@x`;
    }
  // Text the parser refuses, with the marker in every position of each form.
  const refused = [
    'git@github.com:{}/r.git',
    '{}@github.com:o/r.git',
    'https://u:{}@ho st/x?q=1',
    'https://u:p@ho st/{}',
    'https://u:p@[::1/x?{}',
    'https://{}',
    'https://u:{}',
    'https://{}:pw@[::1',
    '{}',
    '../{}/pkg',
    'git+ssh://deploy:{}/y@github.com:o/r.git',
    'git+ssh://deploy:{}:y@github.com:o/r.git',
  ];
  for (const form of refused) yield form.replaceAll('{}', MARKER);
}

/** The innermost parsed URL of an address, following `blob:` as `redactAddress` does. */
function innermost(address: string): URL | undefined {
  let current = address;
  for (let depth = 0; depth < 6; depth += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'blob:') return url;
    current = url.pathname;
  }
  return undefined;
}

/** Whether an output is built only from the fixed words and a scheme. */
const FIXED =
  /^(?:blob:)*(?:\[url\]|(?:[a-z][a-z0-9+.-]*:)?\[address withheld\])$/u;

describe("what redactAddress prints is the parser's, or a fixed word", () => {
  it('never shows the marker unless the parser put it in the host or the path', () => {
    const leaks: string[] = [];
    const outputs = new Map<string, number>();
    let count = 0;
    for (const address of addresses()) {
      count += 1;
      const output = redactAddress(address);
      const url = innermost(address);
      // The marker is the parser's host or path, and no `@` after the authority
      // could be the end of a password the parser split (a path on this machine
      // is the exception: an `@` there is a character).
      const allowed =
        url !== undefined &&
        (url.host + url.pathname).includes(MARKER) &&
        (['file:', 'link:'].includes(url.protocol) ||
          !(url.pathname + url.search + url.hash).includes('@'));
      if (output.includes(MARKER) && !allowed && leaks.length < 8)
        leaks.push(`${JSON.stringify(address)} -> ${JSON.stringify(output)}`);
      const kind = FIXED.test(output) ? 'fixed' : 'components';
      outputs.set(kind, (outputs.get(kind) ?? 0) + 1);
    }
    expect(leaks).toEqual([]);
    expect(count).toBeGreaterThan(15_000);
    // Both kinds of output are exercised, or the grid is not testing what it says.
    expect(outputs.get('fixed')).toBeGreaterThan(1000);
    expect(outputs.get('components')).toBeGreaterThan(1000);
  });

  it("prints the parser's host and path and nothing else, when it prints an address", () => {
    const wrong: string[] = [];
    for (const address of addresses()) {
      const output = redactAddress(address);
      if (FIXED.test(output) || output.includes('… (')) continue;
      const url = innermost(address);
      let shown: URL | undefined;
      try {
        shown = new URL(output.replace(/^(?:blob:)+/u, ''));
      } catch {
        shown = undefined;
      }
      const same =
        url !== undefined &&
        shown !== undefined &&
        shown.protocol === url.protocol &&
        shown.host === url.host &&
        shown.pathname === url.pathname &&
        shown.username === '' &&
        shown.password === '' &&
        shown.search === '' &&
        shown.hash === '';
      if (!same && wrong.length < 8)
        wrong.push(`${JSON.stringify(address)} -> ${JSON.stringify(output)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('cannot tell a password that ends in a / from the path of a scoped tarball', () => {
    // The parser reads `deploy:/<c>/` as a host, an empty port and a path, and
    // `/<c>/@scope/p/-/p-1.0.0.tgz` is `<prefix>/@scope/name/-/file`.
    const address = `https://deploy:/${MARKER}/@scope/p/-/p-1.0.0.tgz`;
    expect(redactAddress(address)).toContain(MARKER);
    // With a port in the host, a dot in it (a host has one, a scope does not),
    // or a name the file does not start with, it is not.
    for (const other of [
      `https://deploy:/${MARKER}/@host.example/p/-/p-1.0.0.tgz`,
      `https://deploy:/${MARKER}/@scope:8443/p/-/p-1.0.0.tgz`,
      `https://deploy:/${MARKER}/@scope/p/-/q-1.0.0.tgz`,
      `https://deploy:/${MARKER}/@scope/p/-/p-1.0.0.zip`,
      `https://deploy:/${MARKER}/@scope/o/r.git`,
    ])
      expect(redactAddress(other)).not.toContain(MARKER);
  });

  it('does not show a host that comes after an @ of the text', () => {
    for (const [address, host] of [
      [
        'https://evil.example/x@registry.npmjs.org/p/-/p-1.0.0.tgz',
        'evil.example',
      ],
      ['https://evil.example/p#x@registry.npmjs.org', 'evil.example'],
      ['git+https://evil.example/a@github.com/o/r.git', 'evil.example'],
      ['git+https://evil.example/o/r.git?u=a@github.com', 'evil.example'],
    ] as const) {
      const output = redactAddress(address);
      expect(output).not.toContain('registry.npmjs.org');
      expect(output).not.toContain('github.com');
      expect(
        output === '[url]' || FIXED.test(output) || output.includes(host),
      ).toBe(true);
    }
  });
});

describe('what redactAddress shows of an address it can read', () => {
  it.each([
    ['https://h.example/a/b.tgz?t=1#f', 'https://h.example/a/b.tgz'],
    ['https://u:p@Host.example:443/a', 'https://host.example/a'],
    ['https://u:p@host.example:8443/a', 'https://host.example:8443/a'],
    [
      'git+https://github.com/o/r.git?email=a@b.com&sig=1',
      'git+https:[address withheld]',
    ],
    [
      'git+https://github.com/o/r.git#semver:^1.2.3',
      'git+https://github.com/o/r.git',
    ],
    ['git+ssh://git@github.com/o/r.git', 'git+ssh://github.com/o/r.git'],
    [
      'https://registry.npmjs.org/@types/node/-/node-1.0.0.tgz',
      'https://registry.npmjs.org/@types/node/-/node-1.0.0.tgz',
    ],
    [
      'http://localhost:4873/pre/@s/p/-/p-1.0.0.tgz',
      'http://localhost:4873/pre/@s/p/-/p-1.0.0.tgz',
    ],
    ['https://registry.npmjs.org/@types/node', 'https:[address withheld]'],
    ['https://cdn.example/pkg@1.2.3/f.js', 'https:[address withheld]'],
    ['github:o/r', 'github:o/r'],
    ['github:o/r#feature@1', 'github:[address withheld]'],
    ['github:u:pw@o/r', 'github:[address withheld]'],
    ['user:pw@host:o/r', '[address withheld]'],
    ['git@github.com:o/r.git', '[address withheld]'],
    ['https://u:p@ho st/x', 'https:[address withheld]'],
    ['file:///srv/@s/pkg?x=1', 'file:///srv/@s/pkg'],
    ['link:../pkg@1.0.0', 'link:../pkg@1.0.0'],
    ['blob:https://u:p@h/x?q#f', 'blob:https://h/x'],
    ['blob:blob:blob:blob:blob:https://h/x', 'blob:blob:blob:blob:[url]'],
  ])('%s -> %s', (address, shown) => {
    expect(redactAddress(address)).toBe(shown);
  });

  it('shows a legal host of non-ASCII labels inside a blob URL', () => {
    // The percent-encoded form of the inner address is longer than 253
    // characters; its host as written is not, and that is what is counted.
    const host = `${'ß'.repeat(42)}.test`;
    expect(redactAddress(`blob:https://${host}/x`)).toMatch(
      /^blob:https:\/\/xn--[a-z0-9-]+\.test\/x$/u,
    );
    expect(redactAddress(`https://${host}/x`)).toMatch(
      /^https:\/\/xn--[a-z0-9-]+\.test\/x$/u,
    );
  });

  it.each([
    // The parser writes `/.` before a path that begins with `//` and has no
    // host, so that it is not read back as a host.
    ['a:/.///b', 'a:/.///b'],
    ['npm:/x/..//u:p/q', 'npm:/.//u:p/q'],
    ['link:/.//d:443?t@127.0.0.1:#', 'link:/.//d:443'],
    ['x:c/b ?', 'x:c/b'],
  ])(
    'writes an address that has no host so that it reads back as itself: %s',
    (address, shown) => {
      const output = redactAddress(address);
      expect(output).toBe(shown);
      expect(new URL(output).pathname).toBe(
        new URL(address).pathname.trimEnd(),
      );
    },
  );

  it('shows at most 256 characters of a host and of a path', () => {
    const path = `/${'é'.repeat(100_000)}`;
    const shown = redactAddress(`git+https://h.example${path}`);
    expect(shown.length).toBeLessThan(600);
    expect(shown).toContain('… (600001 characters)');
    const host = redactAddress(`x://${'é'.repeat(100_000)}/p`);
    expect(host.length).toBeLessThan(600);
    expect(host).toContain('… (600000 characters)');
    expect(redactAddress(`https://h.example/${'a'.repeat(255)}`)).toBe(
      `https://h.example/${'a'.repeat(255)}`,
    );
  });

  it('is linear', () => {
    const started = performance.now();
    redactAddress('blob:'.repeat(200_000));
    redactAddress(`https://${'a'.repeat(1 << 20)}/x`);
    redactAddress(`git+https://h/${'@'.repeat(1 << 20)}`);
    redactAddress(`x:${'@/'.repeat(1 << 19)}`);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
