import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonLimitError,
  DOCUMENT_COST_PER_BYTE,
  documentParseLimits,
  parseCanonicalJson,
  parseCanonicalJsonCosted,
} from '../src/index.js';

/**
 * `documentParseLimits` bounds what a document costs to parse by the bytes its
 * reader lets it have. The factor has to be above what an honest document
 * costs per byte, or a reader refuses its own documents at their byte bound,
 * and well below what a hostile one costs, or it bounds nothing. The honest
 * ones are the repository's own documents, minified as they are sent: the
 * goldens, the PREX pact, packslip's conformance statements and its real and
 * demo bundles (ADR 0044, "Documents other than packuments").
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const jsonIn = (directory: string): string[] =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${directory}/${name}`);
const DOCUMENTS = [
  ...jsonIn('fixtures/golden'),
  ...jsonIn('packages/packslip/test/fixtures/conformance'),
  'packages/packslip/test/fixtures/demo-key-signed/packslip.sigstore.json',
  'packages/packslip/test/fixtures/real/hk-2.5.0.sigstore.json',
  'packages/packslip/test/fixtures/real/packslip-1.5.1.sigstore.json',
  'pacts/Epoch PREX Consumer-OpenPacker PREX Provider.json',
  'tests/fixtures/bounded-solve.json',
];
const minified = (path: string): string =>
  JSON.stringify(JSON.parse(readFileSync(join(root, path), 'utf8')));
const perByte = (text: string): number =>
  parseCanonicalJsonCosted(text).cost / Buffer.byteLength(text);

const MiB = 1024 * 1024;
const filled = (unit: string, bytes: number): string =>
  `[${Array(Math.floor((bytes - 2) / (unit.length + 1)))
    .fill(unit)
    .join(',')}]`;

function refusal(text: string, bytes: number): CanonicalJsonLimitError {
  try {
    parseCanonicalJson(text, documentParseLimits(bytes));
  } catch (error) {
    return error as CanonicalJsonLimitError;
  }
  throw new Error('the document was accepted');
}

describe('what a document of a given size may cost', () => {
  it('is sixteen times its bytes, and never less than 1 MiB', () => {
    expect(DOCUMENT_COST_PER_BYTE).toBe(16);
    expect(documentParseLimits(MiB)).toEqual({ maximumCost: 16 * MiB });
    expect(documentParseLimits(64 * 1024)).toEqual({ maximumCost: MiB });
    expect(documentParseLimits(2)).toEqual({ maximumCost: MiB });
  });

  it('reads a document of a few bytes under a limit of its own size', () => {
    // `{}` costs 240 and `{"a":1}` 304: more than sixteen times their bytes.
    for (const text of ['{}', '{"a":1}', '[[]]'])
      expect(() =>
        parseCanonicalJson(text, documentParseLimits(text.length)),
      ).not.toThrow();
  });

  it("leaves every one of the repository's documents a quarter to spare", () => {
    expect(DOCUMENTS.length).toBeGreaterThanOrEqual(30);
    const ratios = DOCUMENTS.map((path) => perByte(minified(path)));
    // The densest is 11.3 a byte (golden/cyclonedx.json); the least, 2.4.
    expect(Math.max(...ratios)).toBeLessThanOrEqual(
      DOCUMENT_COST_PER_BYTE / 1.25,
    );
  });

  it('reads an honest document as large as its byte bound', () => {
    // The universe golden, its packages repeated until it is a megabyte.
    const universe = JSON.parse(minified('fixtures/golden/universe.json'));
    const text = JSON.stringify(
      Array(Math.floor(MiB / JSON.stringify(universe).length)).fill(universe),
    );
    expect(Buffer.byteLength(text)).toBeGreaterThan(0.95 * MiB);
    expect(() =>
      parseCanonicalJson(text, documentParseLimits(MiB)),
    ).not.toThrow();
  });

  it.each([
    ['{"1023":0}', 'an elements store of 40 KB for 11 bytes'],
    ['{}', 'an object of 240 for 3 bytes'],
    ['[]', 'an array for 3 bytes'],
  ])('refuses a megabyte of %s (%s) before it is built', (unit) => {
    const error = refusal(filled(unit, MiB), MiB);
    expect(error).toBeInstanceOf(CanonicalJsonLimitError);
    expect(error.limit).toBe('cost');
    expect(error.maximum).toBe(16 * MiB);
    // Stopped at the limit, not at the end of the document.
    expect(error.spent).toBeLessThan(16 * MiB + 41_000);
  });
});
