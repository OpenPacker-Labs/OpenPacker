import { describe, expect, it } from 'vitest';
import { formatPurl, parsePurl } from './index.js';

/**
 * An npm scope typed with a literal `@` (`pkg:npm/@vercel/sdk`), the way people
 * and npm itself spell it. The `@` that begins the path cannot be the version
 * separator, since the name before it would be empty; it used to be read as one
 * and every command that parsed the PURL said "PURL path has an empty segment".
 */
describe('a literal @ that begins the path', () => {
  it('is the scope, not a version separator', () => {
    expect(parsePurl('pkg:npm/@vercel/sdk')).toEqual({
      type: 'npm',
      namespace: '@vercel',
      name: 'sdk',
      qualifiers: {},
    });
  });

  it('reads as the encoded spelling, with or without a version', () => {
    expect(parsePurl('pkg:npm/@vercel/sdk')).toEqual(
      parsePurl('pkg:npm/%40vercel/sdk'),
    );
    expect(parsePurl('pkg:npm/@vercel/sdk@1.28.43')).toEqual(
      parsePurl('pkg:npm/%40vercel/sdk@1.28.43'),
    );
    expect(parsePurl('pkg:npm/@vercel/sdk@1.28.43').version).toBe('1.28.43');
  });

  it('is written back encoded, as the npm type requires', () => {
    expect(formatPurl(parsePurl('pkg:npm/@vercel/sdk'))).toBe(
      'pkg:npm/%40vercel/sdk',
    );
    expect(formatPurl(parsePurl('pkg:npm/@vercel/sdk@1.0.0?a=b'))).toBe(
      'pkg:npm/%40vercel/sdk@1.0.0?a=b',
    );
  });

  it('leaves an empty segment refused', () => {
    expect(() => parsePurl('pkg:npm//sdk')).toThrow(/empty segment/u);
    expect(() => parsePurl('pkg:npm/@vercel//sdk')).toThrow(/empty segment/u);
  });
});
