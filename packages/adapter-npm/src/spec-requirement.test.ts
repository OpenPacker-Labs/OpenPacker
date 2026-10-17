import { describe, expect, it } from 'vitest';
import { NpmCodec, type NpmVersionMetadata } from './index.js';

/**
 * A plain dist-tag (`"bar": "latest"`) in a field an install walks is a
 * requirement on the registry's `bar` at the version its dist-tags name, which
 * the resolver reads, as npm and pnpm read it (ADR 0054 §3, amended
 * 2026-10-17). It used to fail the whole package by name.
 */

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '1'.repeat(64) },
};

const translate = (metadata: Record<string, unknown>) =>
  new NpmCodec().translateMetadata(
    // SAFETY: a literal that carries the fields under test.
    { name: 'demo', version: '1.0.0', ...metadata } as NpmVersionMetadata,
    provenance,
  );

describe('a plain dist-tag where the install walks', () => {
  it.each([
    ['dependencies', 'runtime', false],
    ['peerDependencies', 'peer', false],
    ['optionalDependencies', 'optional', true],
  ] as const)(
    'in %s is a requirement on the tag',
    async (field, kind, optional) => {
      const { instance } = await translate({ [field]: { bar: 'next' } });
      expect(instance.requirements).toHaveLength(1);
      const [requirement] = instance.requirements;
      expect(requirement).toMatchObject({
        kind,
        optional,
        expression: { type: 'package', purl: 'pkg:npm/bar' },
        raw: { path: `/${field}/bar`, range: 'next' },
        nativeSemantics: {
          version: 'npm-v1',
          data: { dependencyField: field, range: 'next', specKind: 'tag' },
        },
        semanticLoss: [],
      });
      // The tag is no range: nothing but the registry says which version.
      expect(requirement!.expression).not.toHaveProperty('vers');
    },
  );

  it('names a scoped package the way a range would', async () => {
    const { instance } = await translate({
      dependencies: { '@scope/bar': 'latest' },
    });
    expect(instance.requirements[0]?.expression).toEqual({
      type: 'package',
      purl: 'pkg:npm/%40scope/bar',
    });
  });

  it('refuses a tag npm would not read', async () => {
    // npm-package-arg refuses a tag encodeURIComponent would change.
    await expect(
      translate({ dependencies: { bar: 'not a tag' } }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_DEPENDENCY_SPEC',
      message: expect.stringContaining('depends on bar as "not a tag"'),
    });
  });

  it('keeps a dev-time tag what it was: no constraint, never walked', async () => {
    const { instance } = await translate({
      devDependencies: { bar: 'latest' },
    });
    expect(instance.requirements[0]).toMatchObject({
      kind: 'development',
      optional: true,
      semanticLoss: [{ code: 'NPM_DEPENDENCY_SPEC_NOT_A_RANGE' }],
    });
  });
});
