/**
 * The npm ranges the solver can enforce, as `vers:` constraints. The
 * comparators are node-semver's: a caret, tilde or partial bound is
 * `<X.Y.Z-0`, which keeps that version's prereleases out as npm does.
 */

import { describe, expect, it } from 'vitest';
import { NpmCodec, npmRangeVers, type NpmVersionMetadata } from './index.js';

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '1'.repeat(64) },
};

describe('ranges the solver can enforce', () => {
  const vers = (range: string) =>
    npmRangeVers(new NpmCodec().parseNativeRange(range).ast);

  it.each([
    ['^2.9.0', 'vers:npm/>=2.9.0|<3.0.0-0'],
    ['~1.2.3', 'vers:npm/>=1.2.3|<1.3.0-0'],
    ['>=1 <2', 'vers:npm/>=1.0.0|<2.0.0-0'],
    ['^1 || ^2', 'vers:npm/>=1.0.0|<2.0.0-0||>=2.0.0|<3.0.0-0'],
    ['1.2.3', 'vers:npm/=1.2.3'],
  ])('renders %s as %s', (range, expected) => {
    expect(vers(range)).toBe(expected);
  });

  it.each(['*', '', '^1 || *'])('leaves %j unconstrained', (range) => {
    expect(vers(range)).toBeUndefined();
  });

  it('puts the constraint on the requirement, and says it is a superset', async () => {
    // Before this a caret range reached the solver as "any version".
    const { instance } = await new NpmCodec().translateMetadata(
      // SAFETY: a literal that carries the fields under test.
      {
        name: 'demo',
        version: '1.0.0',
        dependencies: { tinybench: '^2.9.0' },
      } as NpmVersionMetadata,
      provenance,
    );
    const [requirement] = instance.requirements;
    expect(requirement!.expression).toMatchObject({
      purl: 'pkg:npm/tinybench',
      vers: 'vers:npm/>=2.9.0|<3.0.0-0',
    });
    expect(requirement!.semanticLoss[0]).toMatchObject({
      code: 'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE',
      severity: 'warning',
      representedMeaning: expect.stringContaining('superset'),
    });
  });
});
