import { describe, expect, it } from 'vitest';
import { redactAddress, redactAddressText } from './redact-address.js';

const C = 'vtok_dummy_marker_0123456789abcdef';

describe('redactAddressText, for an address the URL parser does not read', () => {
  it.each([
    [
      'userinfo, query and fragment',
      `git+ssh://git@h:o/r.git?t=${C}#${C}`,
      'git+ssh://h:o/r.git',
    ],
    [
      'a password that holds an @',
      `git+ssh://u:${C}@x@h:o/r.git`,
      'git+ssh://h:o/r.git',
    ],
    [
      'a password that holds a ? and a #',
      `git+ssh://u:${C}?x#y@h:o/r.git`,
      'git+ssh://h:o/r.git',
    ],
    [
      'a password that holds a /',
      `git+ssh://u:${C}/y@h:o/r.git`,
      'git+ssh://h:o/r.git',
    ],
    [
      'a password that holds a :',
      `git+ssh://u:${C}:y@h:o/r.git`,
      'git+ssh://h:o/r.git',
    ],
    [
      'no slashes after the scheme',
      `git+ssh:u:${C}@h:o/r.git`,
      'git+ssh:h:o/r.git',
    ],
    ['no scheme, two slashes', `//u:${C}@h/x?y`, '//h/x'],
    [
      'no scheme and no slashes: no userinfo to find',
      `../a@b/c?x=${C}`,
      '../a@b/c',
    ],
    [
      'a scp-like address with no scheme',
      'git@github.com:o/r.git',
      'git@github.com:o/r.git',
    ],
    [
      'a text with nothing to take out',
      'git+ssh://h:o/r.git',
      'git+ssh://h:o/r.git',
    ],
    ['an empty text', '', ''],
    [
      'an @ after the host, which takes the host along',
      'git+ssh://git@h:@scope/p.git',
      'git+ssh://scope/p.git',
    ],
  ])('takes %s out', (_, text, shown) => {
    expect(redactAddressText(text)).toBe(shown);
  });

  it('is linear', () => {
    const started = performance.now();
    redactAddressText(`x://${'@'.repeat(1 << 20)}`);
    redactAddressText(`x://${'a?'.repeat(1 << 19)}`);
    redactAddressText('a'.repeat(1 << 20));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('redactAddress', () => {
  it.each([
    [
      'an https address is its origin and path',
      `https://Host.example:443/a/@s/p.tgz?x=${C}#${C}`,
      'https://host.example/a/@s/p.tgz',
    ],
    [
      'an https address with userinfo, cut as text, at its last @',
      `https://u:${C}@Host.example:443/a/@s/p.tgz?x=${C}#${C}`,
      'https://s/p.tgz',
    ],
    [
      'a registry URL with an @ in its path, as it was',
      'https://registry.npmjs.org/@types/node/-/node-1.0.0.tgz',
      'https://registry.npmjs.org/@types/node/-/node-1.0.0.tgz',
    ],
    [
      'a git URL without userinfo is cleared and kept',
      `git+https://h.example/o/r.git?t=${C}#abc`,
      'git+https://h.example/o/r.git',
    ],
    ['a file URL', `file:///srv/@s/pkg?x=${C}`, 'file:///srv/@s/pkg'],
    ['a hosted shorthand', `github:u:${C}@o/r`, 'github:o/r'],
    [
      'an address the parser refuses',
      `git+ssh://git@h:o/r.git?t=${C}`,
      'git+ssh://h:o/r.git',
    ],
    [
      'a host over 253 characters, read by the parser',
      `http://${'a'.repeat(254)}/x`,
      '[url]',
    ],
    ['the same in a blob URL', `blob:http://${'a'.repeat(254)}/x`, '[url]'],
    ['a blob URL', `blob:https://u:${C}@h/x`, 'blob:https://h/x'],
  ])('shows %s', (_, address, shown) => {
    expect(redactAddress(address)).toBe(shown);
    expect(redactAddress(address)).not.toContain(C);
  });

  /**
   * `user:123/rest@host` has a password `123/rest`, and the parser reads it as
   * the host `user`, the port 123 and a path that holds the rest. No userinfo
   * is found, so the path is where the password is, and an `@` in a path that
   * follows something other than a `/` is where userinfo would end.
   */
  it.each([
    [
      'a password of digits and then a /, under a git scheme',
      `git+ssh://deploy:1234/${C}@github.com:o/r.git`,
      'git+ssh://github.com:o/r.git',
    ],
    [
      'the same under https, on a default port',
      `https://deploy:443/${C}@registry.example/a.tgz`,
      'https://registry.example/a.tgz',
    ],
    [
      'the same, with a / in the rest of the password',
      `https://deploy:8080/a/${C}@registry.example/a.tgz`,
      'https://registry.example/a.tgz',
    ],
    [
      'the same, with a ? where the / was',
      `https://deploy:443?${C}@registry.example/a.tgz`,
      'https://registry.example/a.tgz',
    ],
    [
      'the same, with a # where the / was',
      `git+ssh://deploy:22#${C}@github.com:o/r.git`,
      'git+ssh://github.com:o/r.git',
    ],
    [
      'a name@version segment, which it cannot tell from that, and so costs',
      'https://cdn.example/pkg@1.2.3/f.js',
      'https://1.2.3/f.js',
    ],
  ])('takes out %s', (_, address, shown) => {
    expect(redactAddress(address)).toBe(shown);
    expect(redactAddress(address)).not.toContain(C);
    expect(redactAddress(address)).not.toContain('deploy');
  });

  it.each([
    'https://registry.npmjs.org/@types/node/-/node-1.0.0.tgz',
    'http://localhost:4873/@scope/pkg/-/pkg-1.0.0.tgz',
    'file:///srv/pkgs/pkg@1.0.0.tgz',
    'git+https://github.com/o/r.git',
  ])('leaves %s as it is', (address) => {
    expect(redactAddress(address)).toBe(address);
  });

  it('cannot tell a password that ends in a / from a scoped package', () => {
    // `deploy:123/@host` is a password `123/` and a host, or a host `deploy`,
    // a port and the path of a scoped package. Nothing in it says which; a
    // scoped package is what a lock holds, so it is shown as the second.
    expect(redactAddress('https://deploy:123/@host/x')).toBe(
      'https://deploy:123/@host/x',
    );
  });

  it('reads a few blob URLs one inside the next, and no more', () => {
    expect(redactAddress('blob:blob:blob:https://h/x')).toBe(
      'blob:blob:blob:https://h/x',
    );
    expect(redactAddress(`${'blob:'.repeat(6)}https://h/x`)).toBe(
      'blob:blob:blob:blob:[url]',
    );
    const started = performance.now();
    expect(redactAddress('blob:'.repeat(200_000))).toBe(
      'blob:blob:blob:blob:[url]',
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
