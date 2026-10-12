import { describe, expect, it } from 'vitest';
import {
  LONGEST_HOST_LENGTH,
  OverlongHostError,
  parseUntrustedUrl,
} from '../src/index.js';

/**
 * 16,384 labels of non-ASCII text: 65,536 characters of host. Node's `new URL`
 * takes the square of that length on a special scheme's host, so the same
 * string that the guard answers in a millisecond keeps the real parser busy
 * for most of a second. `the control` below measures that on this machine, so
 * a faster parser or a faster machine is a failure here and not a silent pass.
 */
const LABELS = 'ß.é.'.repeat(16384);
const ESCAPED = '%C3%A9.'.repeat(14043);
const SLOW_MS = 300;
const FAST_MS = 50;

function milliseconds(run: () => void): number {
  const started = performance.now();
  try {
    run();
  } catch {
    // The time is the point.
  }
  return performance.now() - started;
}

/** The least of three runs, so that a pause on a busy machine does not fail a test. */
function fastest(run: () => void): number {
  return Math.min(milliseconds(run), milliseconds(run), milliseconds(run));
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : 'none';
}

function expectRefused(run: () => void): void {
  let error: unknown;
  const elapsed = fastest(() => {
    try {
      run();
    } catch (caught) {
      error = caught;
      throw caught;
    }
  });
  expect(error).toBeInstanceOf(OverlongHostError);
  expect(elapsed).toBeLessThan(FAST_MS);
}

describe('the control', () => {
  it('shows that the real parser needs more than 300 ms for the hostile host', () => {
    expect(
      milliseconds(() => {
        new URL(`https://${LABELS}/x.tgz`);
      }),
    ).toBeGreaterThanOrEqual(SLOW_MS);
  });
});

describe('parseUntrustedUrl', () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ['https', `https://${LABELS}/p/-/p-1.0.0.tgz`],
    ['http', `http://${LABELS}/`],
    ['ws', `ws://${LABELS}`],
    ['wss', `wss://${LABELS}/`],
    ['ftp', `ftp://${LABELS}/f`],
    ['file', `file://${LABELS}/etc/passwd`],
    ['a scheme in capitals', `HTTPS://${LABELS}/`],
    ['backslashes', `https:\\\\${LABELS}\\x`],
    ['no slashes', `https:${LABELS}`],
    ['userinfo', `https://user:pass@${LABELS}/x`],
    ['a stray bracket', `http://x[${LABELS}/`],
    ['tabs inside the scheme', `ht\ttps://${LABELS}/`],
    ['leading spaces', `   https://${LABELS}/`],
    ['a blob', `blob:https://${LABELS}/uuid`],
    ['percent-escaped labels', `https://${ESCAPED}/x`],
  ];

  it.each(forms)('refuses %s in under 50 ms', (_name, address) => {
    expectRefused(() => parseUntrustedUrl(address));
  });

  it('refuses the same text as a base', () => {
    expectRefused(() => parseUntrustedUrl('/x', `https://${LABELS}/`));
  });

  it.each([
    ['//', '//'],
    ['\\\\', '\\\\'],
    ['/\\', '/\\'],
    ['\\/', '\\/'],
    ['a tab between the slashes', '/\t/'],
    ['leading controls', '\u0001 //'],
  ])(
    'refuses a network-path reference written with %s',
    (_name, separators) => {
      expectRefused(() =>
        parseUntrustedUrl(
          `${separators}${LABELS}/x`,
          'https://registry.example/v1/',
        ),
      );
      expectRefused(() =>
        parseUntrustedUrl(`${separators}${LABELS}/x`, new URL('wss://r.test/')),
      );
    },
  );

  it('refuses a host just past 253 characters and keeps one of 253', () => {
    const at = 'a'.repeat(LONGEST_HOST_LENGTH);
    expect(parseUntrustedUrl(`https://${at}/x`).hostname).toBe(at);
    expect(() => parseUntrustedUrl(`https://${at}a/x`)).toThrow(
      OverlongHostError,
    );
  });

  it('says what it refused without repeating any of it', () => {
    let error: unknown;
    try {
      parseUntrustedUrl(`https://\u001b]0;pwned\u0007${LABELS}/x`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    if (!(error instanceof OverlongHostError))
      throw new Error('the refusal is not an OverlongHostError');
    const refusal = error;
    expect(refusal.message).toBe(
      `Invalid URL: its host is longer than ${LONGEST_HOST_LENGTH} characters`,
    );
    expect(refusal.code).toBe('ERR_URL_HOST_TOO_LONG');
    expect(refusal.name).toBe('OverlongHostError');
    expect(JSON.stringify(refusal)).not.toContain('pwned');
    expect(Object.keys(refusal)).not.toContain('input');
  });

  it('does not refuse a relative path that begins with a long segment', () => {
    const segment = 'a'.repeat(400);
    const parsed = parseUntrustedUrl(
      `${segment}/file.tgz`,
      'https://registry.example/v1/',
    );
    expect(parsed.href).toBe(`https://registry.example/v1/${segment}/file.tgz`);
  });
});

describe('parseUntrustedUrl on text that is not hostile', () => {
  const absolute = [
    'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    'http://127.0.0.1:7337/',
    'https://u:p@host.example:8443/a/b?c=d#e',
    'HTTPS://Example.COM/%7Efoo',
    'https://日本語.example/パス',
    'https://[::1]:80/x',
    'file:///etc/hosts',
    'git+ssh://git@github.com/o/r.git',
    'blob:https://example.com/abc',
    'mailto:someone@example.com',
    'data:text/plain,hello',
    'https://xn--n3h.example/',
    'https://1.2.3.4/x',
    'https://0x7f.1/x',
  ];
  const relative: ReadonlyArray<readonly [string, string]> = [
    ['../x.tgz', 'https://registry.example/a/b/'],
    ['/abs/path', 'https://registry.example/a/'],
    ['//cdn.example/x', 'https://registry.example/a/'],
    ['?page=2', 'https://registry.example/list'],
    ['#frag', 'https://registry.example/list'],
    ['next', 'git://host/dir/'],
    ['\\\\cdn.example\\x', 'https://registry.example/'],
  ];
  const broken = [
    '',
    'not a url',
    'https://',
    'https://exa mple.com',
    'http://[::1',
    '/relative/without/base',
    '//no-scheme.example',
  ];

  it.each(absolute)('gives the URL that new URL gives for %s', (address) => {
    expect(parseUntrustedUrl(address).href).toBe(new URL(address).href);
  });

  it('takes a URL that was parsed already and gives back one that equals it', () => {
    const parsed = new URL('https://u:p@host.example:8443/a/b?c=d#e');
    const again = parseUntrustedUrl(parsed);
    expect(again.href).toBe(parsed.href);
    expect(again).not.toBe(parsed);
  });

  it.each(relative)('resolves %s against %s as new URL does', (path, base) => {
    expect(parseUntrustedUrl(path, base).href).toBe(new URL(path, base).href);
    expect(parseUntrustedUrl(path, new URL(base)).href).toBe(
      new URL(path, new URL(base)).href,
    );
  });

  it.each(broken)('throws what new URL throws for %j', (address) => {
    let expected: unknown;
    try {
      new URL(address);
    } catch (caught) {
      expected = caught;
    }
    expect(expected).toBeInstanceOf(TypeError);
    let actual: unknown;
    try {
      parseUntrustedUrl(address);
    } catch (caught) {
      actual = caught;
    }
    expect(actual).toBeInstanceOf(TypeError);
    expect(actual).not.toBeInstanceOf(OverlongHostError);
    expect(codeOf(actual)).toBe(codeOf(expected));
  });
});
