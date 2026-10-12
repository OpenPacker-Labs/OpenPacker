import { describe, expect, it } from 'vitest';
import {
  hasOverlongHost,
  LONGEST_HOST_LENGTH,
  writtenHostLength,
} from './url-host.js';

describe('the host an address names, as written', () => {
  it.each([
    ['an https address', 'https://example.test/x', 12],
    [
      'userinfo, a port, a query and a fragment',
      'https://user:pw@example.test:8443/x?q#f',
      12,
    ],
    ['a host and nothing else', 'http://example.test', 12],
    [
      'a file address, which reads its first segment as the host',
      'file:///srv/pkg',
      3,
    ],
    ['a bracketed host and its port', 'http://[::1]:80/', 5],
    ['a bracket that is never closed', 'http://[::1', 4],
    ['userinfo that ends at the last @', 'https://a@b@host/p', 4],
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
    ['leading space and control characters', ' \u0001 http://host/x', 4],
    ['a tab and newlines inside the host', 'http://ho\tst\n.te\rst/x', 9],
    ['a path where a port goes', 'git+ssh://git@github.com:o/r.git', 10],
    ['an address with no authority', 'github:o/r', 1],
    ['no scheme', '../local/pkg', 0],
    ['a relative reference', '//host/x', 0],
    ['an empty string', '', 0],
    ['a character beyond the basic plane, as two units', 'x://😀/', 2],
  ])('is read from %s', (_, address, length) => {
    expect(writtenHostLength(address)).toBe(length);
  });

  it('is longer than a DNS name only above 253 characters', () => {
    expect(LONGEST_HOST_LENGTH).toBe(253);
    for (const scheme of ['http://', 'https://u:p@', 'x://', 'http:']) {
      expect(hasOverlongHost(`${scheme}${'a'.repeat(253)}/p`)).toBe(false);
      expect(hasOverlongHost(`${scheme}${'a'.repeat(254)}/p`)).toBe(true);
      expect(hasOverlongHost(`${scheme}${'ß.é.'.repeat(64)}`)).toBe(true);
      expect(hasOverlongHost(`${scheme}${'ß.é.'.repeat(63)}ß/p`)).toBe(false);
    }
  });

  it('does not count what is not the host', () => {
    expect(hasOverlongHost(`https://${'u'.repeat(1000)}@host/p`)).toBe(false);
    expect(hasOverlongHost(`https://host:${'9'.repeat(1000)}/p`)).toBe(false);
    expect(
      hasOverlongHost(`https://host/${'p'.repeat(1000)}?${'q'.repeat(1000)}`),
    ).toBe(false);
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
    ['brackets', `http://${'['.repeat(MIB)}`],
    ['tabs', `http://${'\t'.repeat(MIB)}h`],
    ['spaces before the scheme', `${' '.repeat(MIB)}http://h`],
  ])('is found in linear time: %s', (_, address) => {
    const started = performance.now();
    writtenHostLength(address);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
