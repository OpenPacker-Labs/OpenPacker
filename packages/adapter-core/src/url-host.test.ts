import { describe, expect, it } from 'vitest';
import {
  hasOverlongHost,
  LONGEST_HOST_LENGTH,
  writtenHostLength,
} from './url-host.js';

/** 131,072 characters of non-ASCII labels: Node's parser takes a second on them. */
const P = 'ß.é.'.repeat(32768);
/** Percent-escaped labels, 524,286 characters. */
const ESCAPED = '%C3%A9.'.repeat(74898);

describe('the host an address names, as the URL parser reads it', () => {
  it.each([
    ['an https address', 'https://example.test/x', 12],
    [
      'userinfo, a port, a query and a fragment',
      'https://user:pw@example.test:8443/x?q#f',
      12,
    ],
    ['a host and nothing else', 'http://example.test', 12],
    ['a bracketed host and its port', 'http://[::1]:80/', 5],
    ['a bracket that is never closed', 'http://[::1', 4],
    ['userinfo that ends at the last @', 'https://a@b@host/p', 4],
    ['an @ with nothing before it', 'https://@host/p', 4],
    ['a long token in the userinfo', `https://${'u'.repeat(500)}@h/p`, 1],
    ['a long query', `https://h/p?${'q'.repeat(500)}`, 1],
    ['a long path', `https://h/${'p'.repeat(500)}`, 1],
    ['a ? that ends the authority', 'https://host?x=a@b', 4],
    ['a # that ends the authority', 'https://host#a@b', 4],
    [
      'a backslash, which a special scheme reads as a slash',
      'http://host\\path@x',
      4,
    ],
    ['no slashes, as a special scheme reads them', 'http:host/x', 4],
    ['backslashes', 'http:\\\\host/x', 4],
    ['many slashes', 'http:////host/x', 4],
    ['a scheme in capitals', 'HTTP://host/x', 4],
    ['leading space and control characters', ' \u0001 http://host/x', 4],
    [
      'trailing space and control characters, which are stripped',
      'http://host \u0001  ',
      4,
    ],
    ['a space inside the host, which is not', 'http://ho st/x', 5],
    ['a tab and newlines inside the host', 'http://ho\tst\n.te\rst/x', 9],
    ['a tab inside the scheme', 'ht\ttp://host/x', 4],
    ['a character beyond the basic plane, as two units', 'http://😀/', 2],
    ['no scheme', '../local/pkg', 0],
    ['a relative reference', '//host/x', 0],
    ['an empty string', '', 0],
  ])('is read from %s', (_, address, length) => {
    expect(writtenHostLength(address)).toBe(length);
  });

  it.each([
    ['three slashes: the host is empty', 'file:///srv/pkg', 0],
    ['two slashes', 'file://host/x', 4],
    ['two backslashes', 'file:\\\\host\\x', 4],
    ['one slash: there is no host', 'file:/srv/pkg', 0],
    ['no slash: there is no host', 'file:srv/pkg', 0],
    [
      'no slash and a first segment of 300 characters',
      `file:${'a'.repeat(300)}`,
      0,
    ],
    [
      'an @ in the host, which a file URL has no userinfo for',
      'file://a@b/x',
      3,
    ],
    ['a colon in the host, which it has no port for', 'file://a:80/x', 4],
    ['a scheme in capitals', 'FILE://host/x', 4],
  ])('reads a file address with %s', (_, address, length) => {
    expect(writtenHostLength(address)).toBe(length);
  });

  it.each([
    [
      'a scp-like git address, where a path stands where a port goes',
      'git+ssh://git@github.com:o/r.git',
    ],
    ['an opaque host of 300 characters', `x://${'a'.repeat(300)}/p`],
    ['an opaque host of non-ASCII labels', `git+https://${P}/b.git`],
    ['a hosted shorthand', 'github:o/r'],
    ['four slashes', `x:////${'a'.repeat(300)}`],
    ['a link', `link:${'a'.repeat(300)}/x`],
  ])('does not read a host in %s: the parser is linear on it', (_, address) => {
    expect(writtenHostLength(address)).toBe(0);
  });

  it.each([
    ['a path address', 'blob:https://host/x', 4],
    ['userinfo before the host', 'blob:http://u:p@h/x', 1],
    ['capitals and a space', 'BLOB: https://host', 4],
    ['one blob in another', 'blob:blob:https://host', 4],
    ['a path that is not an address', 'blob:x', 0],
    ['a path that is a non-special address', 'blob:git+ssh://host/x', 0],
    ['an address after the ? is not the path', 'blob:x?https://host', 0],
    ['an address after the # is not the path', 'blob:x#https://host', 0],
  ])(
    'reads the address in the path of a blob URL: %s',
    (_, address, length) => {
      expect(writtenHostLength(address)).toBe(length);
    },
  );
});

/**
 * The host the parser gives its host parser is read to the end of the
 * authority, with these exceptions, and Node's parser takes time that grows with
 * the square of its length on raw or percent-escaped non-ASCII labels:
 *
 * - once a `[` is inside the host (not at its start) the parser ignores every
 *   `:` until a `]`, so the port colon is the first `:` outside brackets;
 * - a `file:` host is the whole authority: it has no userinfo and no port.
 */
describe('hosts the first reading of this helper counted short', () => {
  const families: [string, string, string, string][] = [
    ['http', 'http://', 'x[:', ''],
    ['https', 'https://', 'x[:', ''],
    ['ws', 'ws://', 'x[:', ''],
    ['wss', 'wss://', 'x[:', ''],
    ['ftp', 'ftp://', 'x[:', ''],
    ['file', 'file://', 'x[:', ''],
    ['capitals', 'HTTP://', 'x[:', ''],
    ['a bracket and a closing bracket', 'http://', 'x[:', ']'],
    ['a space before a bracketed address', 'http://', ' [::1]', ''],
    ['userinfo before it', 'wss://u:p@', 'x[:', ''],
    ['no slashes', 'http:', 'x[:', ''],
    ['backslashes', 'http:\\\\', 'x[:', ''],
    ['a tab inside', 'http://', 'x[\t:', ''],
    ['a bracket and a port after the payload', 'http://', 'x[', ':80'],
  ];

  it.each(families)('a [ inside the host: %s', (_, before, lead, after) => {
    const address = `${before}${lead}${P}${after}`;
    expect(writtenHostLength(address)).toBe(
      `${lead}${P}${after}`.replace(/\t/gu, '').length,
    );
    expect(hasOverlongHost(address)).toBe(true);
  });

  it('a [ inside the host, percent-escaped labels', () => {
    for (const scheme of ['http', 'https', 'ws', 'wss', 'ftp'])
      expect(hasOverlongHost(`${scheme}://x[:${ESCAPED}`)).toBe(true);
  });

  it.each([
    ['an @ after the payload', 'file://', `${P}@x`],
    ['an @ and a colon', 'file://', `${P}:pw@h`],
    ['a colon first', 'file://', `:${P}`],
    ['a colon after a name', 'file://', `x:${P}`],
    ['userinfo and a colon', 'file://', `u:${P}@h`],
    ['two @', 'file://', `${P}@v@h`],
    ['capitals', 'FILE://', `${P}@x`],
    ['backslashes', 'file:\\\\', `${P}@x`],
  ])('a file host with %s', (_, before, host) => {
    const address = `${before}${host}`;
    expect(writtenHostLength(address)).toBe(host.length);
    expect(hasOverlongHost(address)).toBe(true);
  });

  it('a file host of percent-escaped labels', () => {
    expect(hasOverlongHost(`file://x:${ESCAPED}`)).toBe(true);
    expect(hasOverlongHost(`file://${ESCAPED}@x`)).toBe(true);
  });

  it.each([
    ['http, a [ inside', 'http://x[:', 250, ''],
    ['https, a [ inside, a fragment after', 'https://x[:', 250, '#p'],
    ['file, an @ at the end', 'file://', 251, '@x'],
    ['file, a colon at the start', 'file://:', 252, ''],
    ['file, a colon after a name', 'file://x:', 251, ''],
    ['ws, userinfo before a [', 'ws://u:p@x[:', 250, '#q'],
  ])('the edge is 253: %s', (_, before, filler, after) => {
    const at = (count: number) => `${before}${'a'.repeat(count)}${after}`;
    expect(writtenHostLength(at(filler))).toBe(LONGEST_HOST_LENGTH);
    expect(hasOverlongHost(at(filler))).toBe(false);
    expect(hasOverlongHost(at(filler + 1))).toBe(true);
  });
});

describe('the length a host may have', () => {
  it('is 253, at every special scheme, with anything else around it', () => {
    expect(LONGEST_HOST_LENGTH).toBe(253);
    for (const scheme of ['http://', 'HTTPS://u:p@', 'ws:', 'ftp:\\\\']) {
      expect(hasOverlongHost(`${scheme}${'a'.repeat(253)}/p`)).toBe(false);
      expect(hasOverlongHost(`${scheme}${'a'.repeat(254)}/p`)).toBe(true);
      expect(hasOverlongHost(`${scheme}${'ß.é.'.repeat(64)}`)).toBe(true);
      expect(hasOverlongHost(`${scheme}${'ß.é.'.repeat(63)}ß/p`)).toBe(false);
    }
  });

  it('is 253 after a closing bracket and before a port', () => {
    expect(hasOverlongHost(`http://[::1]${'a'.repeat(248)}:80/p`)).toBe(false);
    expect(hasOverlongHost(`http://[::1]${'a'.repeat(249)}:80/p`)).toBe(true);
  });

  it('does not count what is not the host', () => {
    expect(hasOverlongHost(`https://${'u'.repeat(1000)}@host/p`)).toBe(false);
    expect(hasOverlongHost(`https://@${'a'.repeat(253)}/p`)).toBe(false);
    expect(hasOverlongHost(`https://@${'a'.repeat(254)}/p`)).toBe(true);
    expect(hasOverlongHost(`https://host:${'9'.repeat(1000)}/p`)).toBe(false);
    expect(
      hasOverlongHost(`https://host/${'p'.repeat(1000)}?${'q'.repeat(1000)}`),
    ).toBe(false);
  });

  it('does not count a space that ends the input, which the parser strips', () => {
    expect(hasOverlongHost(`https://${'a'.repeat(253)}   `)).toBe(false);
    expect(hasOverlongHost(`https://${'a'.repeat(253)} \u0001\t`)).toBe(false);
    expect(hasOverlongHost(`https://${'a'.repeat(251)} x`)).toBe(false);
    expect(hasOverlongHost(`https://${'a'.repeat(252)} x`)).toBe(true);
  });

  it('does not count a host of a scheme the parser reads in linear time', () => {
    for (const scheme of ['git+https', 'git+ssh', 'x-custom', 'socks5', 'x'])
      expect(hasOverlongHost(`${scheme}://${P}/p`)).toBe(false);
    expect(hasOverlongHost(`file:///${P}`)).toBe(false);
    expect(hasOverlongHost(`file:${P}`)).toBe(false);
  });

  it('counts the address in the path of a blob URL', () => {
    expect(hasOverlongHost(`blob:https://${P}`)).toBe(true);
    expect(hasOverlongHost(`blob:blob:https://${P}`)).toBe(true);
    expect(hasOverlongHost(`BLOB: http://x[:${P}`)).toBe(true);
    expect(hasOverlongHost(`blob:https://${'a'.repeat(253)}/x`)).toBe(false);
  });
});

describe('the host of a mebibyte', () => {
  const MIB = 1024 * 1024;
  it.each([
    ['one long run with no colon', 'a-'.repeat(MIB / 2)],
    ['one long host', `http://${'ß.é.'.repeat(MIB / 4)}`],
    ['colons', `http://${':'.repeat(MIB)}`],
    ['at signs', `http://${'a@'.repeat(MIB / 2)}h`],
    ['slashes', `http:${'/'.repeat(MIB)}`],
    ['backslashes', `http:${'\\'.repeat(MIB)}h`],
    ['opening brackets', `http://${'['.repeat(MIB)}`],
    ['closing brackets', `http://x${']'.repeat(MIB)}`],
    ['alternating brackets and colons', `http://${'[:]:'.repeat(MIB / 4)}`],
    ['a file host of at signs', `file://${'@'.repeat(MIB)}`],
    ['tabs', `http://${'\t'.repeat(MIB)}h`],
    ['spaces before the scheme', `${' '.repeat(MIB)}http://h`],
    ['spaces after the host', `http://h${' '.repeat(MIB)}`],
    ['blobs', 'blob:'.repeat(MIB / 5)],
    [
      'blobs and a host',
      `${'blob: '.repeat(MIB / 12)}http://${'a'.repeat(1000)}`,
    ],
  ])('is found in linear time: %s', (_, address) => {
    const started = performance.now();
    writtenHostLength(address);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/**
 * Found by changing `url-host.ts` one token at a time and running these tests
 * (`mut3.py` in the round-3 report): each row below fails one of the changes
 * that nothing else failed.
 */
describe('the edges of the reading', () => {
  it.each([
    ['a drive letter and a colon', 'file://C:/Windows', 0],
    ['a lower-case drive letter and a bar', 'file://c|/x', 0],
    ['an upper-case drive letter and a bar', 'file://C|/x', 0],
    ['a drive letter at the end of the input', 'file://z:', 0],
    ['a letter and a colon, then more: a host', 'file://c:x/y', 3],
    ['a digit and a colon: a host', 'file://1:/x', 2],
    ['a letter and another mark: a host', 'file://c;/x', 2],
    ['the character before a, which is not a letter', 'file://`:/x', 2],
    ['the character after z, which is not a letter', 'file://{:/x', 2],
    ['@, which only differs from a backquote by a bit', 'file://@:/x', 2],
    ['[, which only differs from a brace by a bit', 'file://[:/x', 2],
    ['a first character that is not a slash', 'file:x/hhhh', 0],
    ['a second character that is not a slash', 'file:/xhhhh', 0],
  ])('reads %s: %s', (_, address, length) => {
    expect(writtenHostLength(address)).toBe(length);
  });

  it.each([
    ['a ? after spaces', ' ?x'],
    ['a # after spaces', '  #x'],
    ['a ? after a control character', '\u0001?x'],
  ])(
    'does not count the spaces that end the address in a blob URL: %s',
    (_, after) => {
      const host = (count: number) => `blob:http://${'a'.repeat(count)}`;
      expect(hasOverlongHost(`${host(253)}${after}`)).toBe(false);
      expect(hasOverlongHost(`${host(254)}${after}`)).toBe(true);
    },
  );
});

/**
 * Node's parser is not the Standard where a host holds a `[` that is not its
 * first character and is never closed: the Standard ends the host at the end of
 * the authority, and Node reads on past `/`, `?` and `\` to the next `#` or the
 * end of the input, which is where its time goes (a quadratic cost on non-ASCII
 * labels). `test/url-host.parser.test.ts` times the real parser on these.
 */
describe('where Node reads a host further than the Standard does', () => {
  it.each([
    ['a path', 'http://x[h.test/abc', 'x[h.test/abc'],
    ['a query', 'https://reg.example[/p?q', 'reg.example[/p?q'],
    ['userinfo, then a backslash', 'ws://u:p@a]b[c\\tail', 'a]b[c\\tail'],
    ['a port, which the bracket switches off', 'http://x[h:80/P', 'x[h:80/P'],
    ['a fragment, which ends it', 'ftp://x[h.test#frag', 'x[h.test'],
    ['a path and then a fragment', 'http://x[h.test/p#frag', 'x[h.test/p'],
    ['no slashes', 'http:x[h.test/abc', 'x[h.test/abc'],
    ['backslashes', 'http:\\\\x[h.test/abc', 'x[h.test/abc'],
    ['a blob URL, to the end of its path', 'blob:http://x[h/p?q', 'x[h/p'],
  ])('reads on past the authority: %s', (_, address, host) => {
    expect(writtenHostLength(address)).toBe(host.length);
  });

  it.each([
    ['a bracket that is closed', 'http://x[h]y/P', 5],
    ['a bracket that comes first, which is refused at once', 'http://[x/P', 2],
    ['a file host, which has no brackets', 'file://x[h/P', 3],
    ['an opaque host', 'git+https://x[h/P', 0],
  ])('does not read on: %s', (_, address, length) => {
    expect(writtenHostLength(address)).toBe(length);
  });

  it('counts the tail against the limit of 253', () => {
    const at = (count: number) => `http://x[${'a'.repeat(count)}`;
    expect(hasOverlongHost(at(251))).toBe(false);
    expect(hasOverlongHost(at(252))).toBe(true);
    expect(
      hasOverlongHost(`http://x[${'a'.repeat(100)}/${'a'.repeat(150)}`),
    ).toBe(false);
    expect(
      hasOverlongHost(`http://x[${'a'.repeat(100)}/${'a'.repeat(151)}`),
    ).toBe(true);
    expect(hasOverlongHost(`http://x[${'a'.repeat(252)}#${P}`)).toBe(true);
    expect(hasOverlongHost(`http://x[${'a'.repeat(250)}#${P}`)).toBe(false);
  });
});
