import { describe, expect, it } from 'vitest';
import { bundledDependencyNames } from './bundled.js';
import { NpmCodec, type NpmVersionMetadata } from './index.js';

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

describe('a dependency the package bundles', () => {
  it.each([
    [{ bundleDependencies: ['a'] }, ['a']],
    [{ bundledDependencies: ['a', 'b'] }, ['a', 'b']],
    [{ bundleDependencies: true }, ['a', 'b']],
    [{ bundleDependencies: false }, []],
    [{ bundleDependencies: 'a' }, []],
    [{}, []],
  ])('reads %j as %j', (fields, names) => {
    expect(
      [
        ...bundledDependencyNames({
          dependencies: { a: '1', b: '1' },
          ...fields,
        }),
      ].sort(),
    ).toEqual(names);
  });

  it('is recorded and not required, so the solve does not look for it', async () => {
    const { instance } = await translate({
      dependencies: { bundled: '^1', free: '^1' },
      bundleDependencies: ['bundled'],
    });
    const byName = Object.fromEntries(
      instance.requirements.map((requirement) => [
        requirement.id.split(':').at(-1)!,
        requirement,
      ]),
    );
    expect(byName.free).toMatchObject({ optional: false });
    expect(byName.bundled).toMatchObject({
      optional: true,
      nativeSemantics: { data: { bundled: true } },
    });
    expect(byName.bundled?.semanticLoss.map((loss) => loss.code)).toContain(
      'NPM_DEPENDENCY_BUNDLED',
    );
    expect(
      byName.bundled?.semanticLoss.find(
        (loss) => loss.code === 'NPM_DEPENDENCY_BUNDLED',
      )?.severity,
    ).toBe('info');
  });

  it('does not fail the package when the bundled dependency is not a registry range', async () => {
    const { instance } = await translate({
      dependencies: { local: 'github:user/local' },
      bundleDependencies: ['local'],
    });
    expect(instance.requirements[0]).toMatchObject({ optional: true });
  });
});
