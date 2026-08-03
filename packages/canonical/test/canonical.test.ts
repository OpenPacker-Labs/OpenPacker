import { describe, expect, it } from 'vitest';
import {
  canonicalProjectionDigest,
  canonicalDigest,
  canonicalize,
  formatDigest,
  parseCanonicalJson,
  parseDigest,
  projectCanonicalValue,
  sha256,
} from '../src/index.js';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';

describe('PREX canonical JSON', () => {
  it('sorts keys recursively without changing array order', () => {
    expect(canonicalize({ z: 1, a: { y: true, x: [3, 2, 1] } })).toBe(
      '{"a":{"x":[3,2,1],"y":true},"z":1}',
    );
  });

  it('rejects duplicate members before object construction', () => {
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(
      /Duplicate object member/,
    );
  });

  it.each(['-0', '1.5', '9007199254740992', '"\\ud800"'])(
    'rejects non-PREX I-JSON %s',
    (input) => {
      expect(() => parseCanonicalJson(input)).toThrow();
    },
  );

  it('rejects cycles and non-JSON values', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalize(value as never)).toThrow(/Cyclic/);
    expect(() => canonicalize({ value: undefined } as never)).toThrow(
      /Unsupported/,
    );
  });

  it('hashes canonical UTF-8 bytes and round-trips digest strings', async () => {
    const digest = await canonicalDigest({});
    expect(formatDigest(digest)).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(parseDigest(formatDigest(digest))).toEqual(digest);
    expect(await sha256(new Uint8Array())).toEqual({
      algorithm: 'sha256',
      value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('applies named digest projections without mutating the input', async () => {
    const projection = DIGEST_PROJECTIONS.projections.find(
      ({ id }) => id === 'universe-v1',
    )!;
    const value = {
      universeVersion: '1',
      packages: [{ nodeId: 'b' }, { nodeId: 'a' }],
      overlays: [],
      sourceSnapshots: [],
      canonicalDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    };
    expect(projectCanonicalValue(value, projection)).toEqual({
      universeVersion: '1',
      packages: [{ nodeId: 'a' }, { nodeId: 'b' }],
      overlays: [],
      sourceSnapshots: [],
    });
    expect(value.packages[0]?.nodeId).toBe('b');
    expect(
      formatDigest(await canonicalProjectionDigest(value, projection)),
    ).toBe(
      'sha256:4b1d2f63f36b7bb39a1330fcc07c7735100de097e10c32cbd6a4805c4f917935',
    );
  });
});
