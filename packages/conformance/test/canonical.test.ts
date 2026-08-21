import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  canonicalize,
  formatDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../../../fixtures/protocol/canonical',
);

describe('canonical golden vectors', () => {
  it('matches exact bytes and SHA-256 digests', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fixture = JSON.parse(
      await readFile(path.join(fixtureRoot, 'objects.json'), 'utf8'),
    ) as {
      vectors: Array<{ value: JsonValue; canonical: string; digest: string }>;
    };
    for (const vector of fixture.vectors) {
      expect(canonicalize(vector.value)).toBe(vector.canonical);
      expect(formatDigest(await canonicalDigest(vector.value))).toBe(
        vector.digest,
      );
    }
  });

  it('rejects every negative text vector', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fixture = JSON.parse(
      await readFile(path.join(fixtureRoot, 'negative.json'), 'utf8'),
    ) as { vectors: Array<{ json: string; error: string }> };
    for (const vector of fixture.vectors)
      expect(() => parseCanonicalJson(vector.json)).toThrow(
        new RegExp(vector.error, 'i'),
      );
  });
});
