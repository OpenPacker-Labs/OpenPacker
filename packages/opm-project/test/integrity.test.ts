import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  integrityKey,
  strongestClaims,
} from '../src/integrity.js';

const bytes = new TextEncoder().encode('the tarball');
const sri = (algorithm: string) =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;

describe('strongestClaims', () => {
  it('reads sha512, and sha1 where that is all a lock has', () => {
    expect(strongestClaims(sri('sha512'), 'x')[0]).toMatchObject({
      algorithm: 'sha512',
    });
    expect(strongestClaims(sri('sha1'), 'x')[0]).toMatchObject({
      algorithm: 'sha1',
    });
  });

  it('lets the strongest algorithm decide, and drops the weaker ones', () => {
    const claims = strongestClaims(`${sri('sha1')} ${sri('sha256')}`, 'x');
    expect(claims.map((claim) => claim.algorithm)).toEqual(['sha256']);
  });

  it('keeps every token of the strongest algorithm', () => {
    const other = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    expect(strongestClaims(`${sri('sha512')} ${other}`, 'x')).toHaveLength(2);
  });

  it('ignores SRI options after the digest', () => {
    expect(
      strongestClaims(`${sri('sha512')}?ct=application/gzip`, 'x'),
    ).toHaveLength(1);
  });

  it('refuses a value that cannot be checked, naming where it came from', () => {
    for (const bad of [
      '',
      'md5-AAAA',
      'sha512-AAAA',
      'sha512-not base64!',
      `sha512-${Buffer.alloc(32).toString('base64')}`,
      'plain',
    ])
      expect(
        () => strongestClaims(bad, 'a@1.0.0 at node_modules/a'),
        bad,
      ).toThrow(
        /a@1\.0\.0 at node_modules\/a has an integrity value opm cannot check/u,
      );
  });
});

describe('checkIntegrity', () => {
  it('passes the bytes the digest names and fails any others', () => {
    const claims = strongestClaims(sri('sha512'), 'x');
    expect(checkIntegrity(bytes, claims)).toEqual({ ok: true });
    const result = checkIntegrity(new TextEncoder().encode('other'), claims);
    expect(result).toEqual({
      ok: false,
      actual: `sha512-${createHash('sha512').update('other').digest('base64')}`,
    });
  });

  it('passes if any token of the strongest algorithm matches', () => {
    const wrong = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    expect(
      checkIntegrity(bytes, strongestClaims(`${wrong} ${sri('sha512')}`, 'x')),
    ).toEqual({
      ok: true,
    });
  });

  it('does not let a matching weaker token excuse a wrong stronger one', () => {
    const wrong = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    const claims = strongestClaims(`${wrong} ${sri('sha1')}`, 'x');
    expect(checkIntegrity(bytes, claims).ok).toBe(false);
  });
});

describe('integrityKey', () => {
  it('names the bytes by the lock digest, the same for any spelling of it', () => {
    const key = integrityKey(strongestClaims(sri('sha512'), 'x'));
    expect(key).toBe(
      `sha512-${createHash('sha512').update(bytes).digest('hex')}`,
    );
    expect(integrityKey(strongestClaims(`${sri('sha512')}?x=1`, 'x'))).toBe(
      key,
    );
  });
});
