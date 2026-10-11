import { describe, expect, it } from 'vitest';
import type { FrozenLockPackage } from '@openpacker/adapter-core';
import {
  assertFrozenAllowed,
  frozenFacts,
  frozenPolicyDocument,
} from '../src/frozen-policy.js';

const pkg = (over: Partial<FrozenLockPackage> = {}): FrozenLockPackage => ({
  path: 'node_modules/a',
  name: 'a',
  packageName: 'a',
  version: '1.0.0',
  purl: 'pkg:npm/a',
  exactPurl: 'pkg:npm/a@1.0.0',
  source: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
  sourceKind: 'registry',
  integrity: 'sha512-x',
  direct: true,
  scope: 'runtime',
  hasInstallScript: false,
  ...over,
});

const check = (
  packages: FrozenLockPackage[],
  policy: Parameters<typeof frozenPolicyDocument>[0] = undefined,
) =>
  assertFrozenAllowed(
    frozenPolicyDocument(policy),
    packages,
    'npm',
    '2026-10-11T12:00:00.000Z',
  );

describe('the policy a frozen install evaluates', () => {
  it('is the default policy less the minimum release age', () => {
    const document = frozenPolicyDocument(undefined);
    expect(document.minimumReleaseAgeMinutes).toBeUndefined();
    expect(document.blockExoticSources).toEqual({
      transitive: true,
      direct: false,
    });
    expect(document.allowYanked).toBe(false);
  });

  it('lets a registry package with no publish time through', async () => {
    await expect(check([pkg()])).resolves.toBeUndefined();
  });

  it('builds facts from the lock and nothing else', () => {
    expect(frozenFacts(pkg({ direct: false }), 'npm', 'T')).toMatchObject({
      packageId: 'pkg:npm/a@1.0.0',
      provider: 'npm',
      sourceKind: 'registry',
      sourceScheme: 'https',
      dependencyDepth: 1,
      lifecycle: { status: 'published', eligible: true },
      lifecycleScriptsDeclared: false,
      lifecycleScriptsExecuted: false,
    });
    expect(frozenFacts(pkg(), 'npm', 'T').publishedAt).toBeUndefined();
  });

  it('keeps a deprecated release eligible, as npm does', async () => {
    await expect(
      check([pkg({ deprecated: 'use b' })]),
    ).resolves.toBeUndefined();
  });

  it('denies a release the lock marks withdrawn, unless the project allows that kind', async () => {
    for (const withdrawn of [
      'yanked',
      'quarantined',
      'revoked',
      'delisted',
    ] as const)
      await expect(
        check([pkg({ withdrawn })]),
        withdrawn,
      ).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        message: expect.stringMatching(
          new RegExp(`lifecycle\\.${withdrawn}`, 'u'),
        ),
      });
    await expect(
      check([pkg({ withdrawn: 'yanked' })], {
        allowYanked: true,
        allowQuarantined: false,
        semanticLossMaximum: 'warning',
        requiredEvidence: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks a transitive archive from outside a registry and not a direct one', async () => {
    const url = {
      sourceKind: 'tarball' as const,
      source: 'https://example.com/a.tgz',
    };
    await expect(
      check([pkg({ ...url, direct: true })]),
    ).resolves.toBeUndefined();
    await expect(check([pkg({ ...url, direct: false })])).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('names every package it refuses, in one error', async () => {
    const bad = (path: string) =>
      pkg({
        path,
        name: path,
        packageName: path,
        sourceKind: 'tarball',
        source: `https://example.com/${path}.tgz`,
        direct: false,
      });
    await expect(check([bad('x'), pkg(), bad('y')])).rejects.toMatchObject({
      message: expect.stringMatching(
        /refuses 2 packages.*\n {2}x \(x@1\.0\.0\).*\n {2}y \(y@1\.0\.0\)/u,
      ),
    });
  });

  it('fails closed on evidence the lock cannot supply', async () => {
    await expect(
      check([pkg()], {
        allowYanked: false,
        allowQuarantined: false,
        semanticLossMaximum: 'warning',
        requiredEvidence: ['sigstore'],
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
  });
});
