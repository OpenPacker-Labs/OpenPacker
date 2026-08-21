import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  parseCanonicalJson,
  projectCanonicalValue,
} from '../src/index.js';
import { DIGEST_PROJECTIONS, type JsonValue } from '@openpacker/contracts';

/**
 * Characterization snapshots for the canonical JSON rendering. These pin the
 * exact byte-level output contract (key ordering, number forms, unicode
 * handling) that every digest in the protocol depends on. Update deliberately
 * with `vitest run -u` and review the snapshot diff like a schema change.
 */
describe('canonical rendering snapshots', () => {
  it('pins the rendering of a representative nested document', async () => {
    const document: JsonValue = {
      zebra: [3, 1, 2],
      alpha: { nested: true, nothing: null },
      unicode: 'café ☕ 日本語',
      'key with spaces': { deep: [{ b: 1, a: 2 }] },
      numbers: [0, 1, -42, 9007199254740991, 123456789],
      empty: { object: {}, array: [] },
    };
    await expect(canonicalize(document)).toMatchFileSnapshot(
      '__snapshots__/canonical-document.snap',
    );
  });

  it('pins the projected rendering used by protocol digests', async () => {
    const projection = DIGEST_PROJECTIONS.projections.find(
      (candidate) => candidate.id === 'package-node-v1',
    );
    if (!projection) throw new Error('missing package-node-v1 projection');
    const node = {
      nodeId: 'sha256:ignored-by-projection',
      identity: {
        ecosystem: 'npm',
        name: 'demo',
        version: '1.0.0',
        exactPurl: 'pkg:npm/demo@1.0.0',
      },
      nativeSemantics: { version: '1.0.0' },
      extraFieldExcludedByProjection: 'must not appear',
    } as unknown as JsonValue;
    const projected = projectCanonicalValue(node, projection);
    await expect(canonicalize(projected)).toMatchFileSnapshot(
      '__snapshots__/package-node-projection.snap',
    );
  });

  it('snapshot round-trips through the strict parser', () => {
    const document = canonicalize({ b: [2, { d: 4, c: 3 }], a: 1 });
    expect(parseCanonicalJson(document)).toEqual({
      a: 1,
      b: [2, { c: 3, d: 4 }],
    });
  });
});
