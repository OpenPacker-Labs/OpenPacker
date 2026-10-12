import { describe, expect, it } from 'vitest';
import { redactAddresses } from './redact.js';

const COMMIT = 'b'.repeat(40);

const CHANGED: readonly (readonly [
  label: string,
  text: string,
  shown: string,
])[] = [
  [
    'a user and password',
    'https://user:secret@host/a.tgz',
    'https://[redacted]@host/a.tgz',
  ],
  [
    'a token as the user',
    'https://tok_0123456789@host/a.tgz',
    'https://[redacted]@host/a.tgz',
  ],
  [
    'an unescaped @ in the password',
    'https://user:p@ss@host/a.tgz',
    'https://[redacted]@host/a.tgz',
  ],
  [
    'an @ in the user, as an email address',
    'https://me@example.com:token@host/a.tgz',
    'https://[redacted]@host/a.tgz',
  ],
  [
    'a user other than git over ssh',
    'git+ssh://deploy@host/o/r.git',
    'git+ssh://[redacted]@host/o/r.git',
  ],
  [
    'a password for git over ssh',
    'ssh://git:secret@host/o/r.git',
    'ssh://[redacted]@host/o/r.git',
  ],
  [
    'an address with no path, inside quotes',
    '"a@https://user:secret@host"',
    '"a@https://[redacted]@host"',
  ],
  [
    'a query string',
    'https://host/a.tgz?sig=abc&x=1',
    'https://host/a.tgz?[redacted]',
  ],
  [
    'a query string ahead of a fragment',
    'https://host/a.tgz?sig=abc#frag',
    'https://host/a.tgz?[redacted]#frag',
  ],
  [
    'a query string that ends at a quote',
    '"https://host/a.tgz?sig=abc" is refused',
    '"https://host/a.tgz?[redacted]" is refused',
  ],
  [
    'user information and a query string together',
    'a@https://u:p@host/a.tgz?sig=abc',
    'a@https://[redacted]@host/a.tgz?[redacted]',
  ],
  [
    'several addresses in one message',
    'https://u:p@h1/a and http://t@h2/b',
    'https://[redacted]@h1/a and http://[redacted]@h2/b',
  ],
  [
    'an address in a path to a failure',
    'packages["a@https://u:p@host/a.tgz"].resolution is bad',
    'packages["a@https://[redacted]@host/a.tgz"].resolution is bad',
  ],
];

const UNCHANGED: readonly (readonly [label: string, text: string])[] = [
  ['text with no address', 'a@1.0.0(b@2.0.0) has no version'],
  ['an SCP-style git address', 'git@github.com:owner/repo.git'],
  ['the user git over ssh', 'git+ssh://git@host/o/r.git'],
  ['no user', 'https://host/a.tgz'],
  ['a port', 'https://host:8443/a.tgz'],
  [
    'an @ in a path (a scoped package on a registry)',
    'https://host/@scope/a/-/a-1.0.0.tgz',
  ],
  ['a git commit as the fragment', `git+https://host/o/r.git#${COMMIT}`],
  ['a git subdirectory', `git+https://host/o/r.git#${COMMIT}&path:packages/a`],
  ['a file path', 'file:../vendor/a'],
  ['the empty string', ''],
];

describe('redactAddresses', () => {
  it.each(CHANGED)('removes %s', (_label, text, shown) => {
    expect(redactAddresses(text)).toBe(shown);
  });

  it.each(UNCHANGED)('leaves %s as it is', (_label, text) => {
    expect(redactAddresses(text)).toBe(text);
  });

  it('is idempotent', () => {
    for (const [, text] of CHANGED) {
      const once = redactAddresses(text);
      expect(redactAddresses(once)).toBe(once);
    }
  });

  it('leaves none of a secret behind, not even a prefix of it', () => {
    const secret = 'sEcReT0123456789';
    const shown = redactAddresses(
      `a@https://user:${secret}@host/a.tgz?sig=${secret}`,
    );
    expect(shown).not.toContain('sEcR');
    expect(shown).toBe('a@https://[redacted]@host/a.tgz?[redacted]');
  });

  it('reads a long run of text once, not once per character', () => {
    const run = 'a'.repeat(300_000);
    // A scheme-like run that no `://` follows is the case that is quadratic
    // without the look-behind: every letter of it starts a scan to the end.
    const noScheme = `${run} ://${run}`;
    const started = performance.now();
    expect(redactAddresses(noScheme)).toBe(noScheme);
    expect(redactAddresses(`x://${run}@${run}`)).toBe(`x://[redacted]@${run}`);
    expect(redactAddresses('://'.repeat(100_000))).toBe('://'.repeat(100_000));
    // Quadratic scanning of these takes minutes; a generous bound is all this needs to tell.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
