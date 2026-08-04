import { describe, expect, it } from 'vitest';
import { PackageURL } from 'packageurl-js';
import { parsePurl, formatPurl } from '../src/index.js';

/**
 * Cross-checks this package's PURL parser against `packageurl-js`, the
 * reference implementation from the purl-spec authors.
 *
 * `packageurl-js` is a dev dependency rather than a runtime one, deliberately.
 * Two reasons:
 *
 *  1. This parser is intentionally *stricter* than the specification. It
 *     refuses duplicate qualifiers, empty path segments, empty qualifier names
 *     and PURLs beyond 4096 characters; the reference implementation accepts
 *     all four. For a package manager those are not pedantry — a PURL that
 *     parses two ways is an identity that means two things.
 *  2. `identity.exactPurl` feeds every node ID. A dependency whose
 *     normalization changed in a future release would silently move every
 *     identity in every universe.
 *
 * So the library is the oracle and not the implementation: it pins conformance
 * on everything both accept, while the strictness stays under this repository's
 * control.
 */
describe('PURL parsing agrees with the reference implementation', () => {
  const corpus = [
    'pkg:npm/lodash@4.17.21',
    'pkg:npm/%40openpacker/demo-tool@1.1.0',
    'pkg:cargo/demo-zstd@1.0.0',
    'pkg:maven/org.example/demo-tool@1.0.0?classifier=sources&type=war',
    'pkg:pypi/demo-tool@1.0.0',
    'pkg:golang/github.com/openpacker/demo-zstd@v1.0.0',
    'pkg:nuget/Demo.Tool@1.0.0',
    'pkg:nix/libgreet@1.0?outhash=abc&output=out',
    'pkg:generic/thing@1.0.0#sub/path',
  ];

  it.each(corpus)('parses %s the same way', (purl) => {
    const mine = parsePurl(purl);
    const theirs = PackageURL.fromString(purl);
    const blank = (value: string | null | undefined) =>
      value === null || value === undefined || value === '' ? undefined : value;

    expect(mine.type).toBe(theirs.type);
    expect(blank(mine.namespace)).toBe(blank(theirs.namespace));
    expect(mine.name).toBe(theirs.name);
    expect(blank(mine.version)).toBe(blank(theirs.version));
    expect(mine.qualifiers ?? {}).toEqual(
      Object.fromEntries(Object.entries(theirs.qualifiers ?? {}).sort()),
    );
  });

  it('round-trips every corpus PURL through its own formatter', () => {
    for (const purl of corpus)
      expect(formatPurl(parsePurl(purl))).toBe(
        formatPurl(parsePurl(formatPurl(parsePurl(purl)))),
      );
  });

  it('is stricter than the reference, on purpose', () => {
    // Each of these is accepted by the reference implementation. Ambiguity in
    // a package identity is a supply-chain problem, so this parser refuses
    // them — and that difference is asserted rather than left to drift.
    const ambiguous = [
      ['duplicate qualifier', 'pkg:npm/a@1?x=1&x=2'],
      ['empty path segment', 'pkg:npm//empty-segment@1'],
      ['empty qualifier name', 'pkg:npm/name@1?=novalue'],
      ['unbounded length', `pkg:npm/${'a'.repeat(5000)}@1`],
    ] as const;

    for (const [why, value] of ambiguous) {
      expect(
        () => parsePurl(value),
        `${why}: this parser must refuse`,
      ).toThrow();
      expect(
        () => PackageURL.fromString(value),
        `${why}: reference still accepts it — if this ever throws, the
         strictness note above can be revisited`,
      ).not.toThrow();
    }
  });
});
