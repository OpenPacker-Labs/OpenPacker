import { expect, test } from 'vitest';
import {
  evaluatePolicy,
  policyDocumentFromPolicyInput,
  TRUST_TIER_RANK,
  type PolicyDocument,
} from '../src/index.js';
import type { PolicyInput } from '@openpacker/contracts';

const policy: PolicyDocument = {
  allowYanked: false,
  allowQuarantined: false,
  requiredEvidence: ['optional', 'receipt-signature', 'tuf'],
  semanticLossMaximum: 'warning',
  acceptedIdentities: ['release@example.test'],
  acceptedIssuers: ['https://issuer.example'],
  deniedLicenses: ['GPL-3.0-only'],
  allowedProviders: ['fixture'],
  allowedSourceSchemes: ['https'],
  allowedTargets: [{ os: 'linux', architecture: 'x86_64' }],
  maximumArtifactSize: 100,
  maximumExpandedSize: 200,
  requireExactSourceSnapshot: true,
};

test('policy preserves valid, invalid, absent, unknown, not-applicable, and denied outcomes', async () => {
  const denied = await evaluatePolicy(policy, {
    evidence: [
      { type: 'receipt-signature', status: 'valid' },
      { type: 'tuf', status: 'invalid' },
      { type: 'optional', status: 'not-applicable' },
    ],
    lifecycle: { status: 'yanked', eligible: false, warnings: [] },
    signerIdentity: 'attacker',
    sigstoreIssuer: 'https://issuer.example',
    licenses: [{ status: 'unknown' }],
    provider: 'fixture',
    sourceScheme: 'https',
    target: { os: 'linux', architecture: 'x86_64' },
    artifactSize: 10,
    expandedSize: 20,
    exactSourceSnapshot: true,
  });
  expect(denied.decision).toBe('deny');
  expect(denied.checks.map((check) => check.status)).toEqual(
    expect.arrayContaining([
      'valid',
      'invalid',
      'unknown',
      'not-applicable',
      'policy-denied',
    ]),
  );
  const absent = await evaluatePolicy(policy, {
    evidence: [],
    provider: 'fixture',
    sourceScheme: 'https',
    target: { os: 'linux', architecture: 'x86_64' },
    artifactSize: 10,
    expandedSize: 20,
    exactSourceSnapshot: true,
    signerIdentity: 'release@example.test',
    sigstoreIssuer: 'https://issuer.example',
    licenses: [{ status: 'declared', expression: 'MIT' }],
  });
  expect(absent.decision).toBe('indeterminate');
  expect(absent.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: 'not-provided' }),
    ]),
  );
});

test('required evidence is valid-only and duplicate facts fail closed', async () => {
  const required = {
    allowYanked: false,
    allowQuarantined: false,
    requiredEvidence: ['tuf'],
    semanticLossMaximum: 'warning' as const,
  };
  const lifecycle = {
    status: 'published' as const,
    eligible: true,
    warnings: [],
  };
  await expect(
    evaluatePolicy(required, {
      evidence: [{ type: 'tuf', status: 'not-applicable' }],
      lifecycle,
    }),
  ).resolves.toMatchObject({ decision: 'indeterminate' });
  await expect(
    evaluatePolicy(required, {
      evidence: [
        { type: 'tuf', status: 'valid' },
        { type: 'tuf', status: 'invalid' },
      ],
      lifecycle,
    }),
  ).resolves.toMatchObject({ decision: 'deny' });
  await expect(
    evaluatePolicy(required, {
      evidence: [{ type: 'tuf', status: 'valid' }],
      lifecycle: {
        status: 'ownership-transferred',
        eligible: false,
        warnings: [],
      },
    }),
  ).resolves.toMatchObject({ decision: 'deny' });
});

const baseSupply: PolicyDocument = {
  allowYanked: false,
  allowQuarantined: false,
  requiredEvidence: [],
  semanticLossMaximum: 'warning',
};

const eligible = {
  status: 'published' as const,
  eligible: true,
  warnings: [] as string[],
};

test('minimumReleaseAge denies versions inside the detection window', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    minimumReleaseAgeMinutes: 1440,
  };
  const denied = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/left-pad',
    publishedAt: '2026-08-04T12:00:00Z',
    evaluationTime: '2026-08-04T18:00:00Z', // 6h < 24h
  });
  expect(denied.decision).toBe('deny');
  expect(denied.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'supply-chain.release-age',
        status: 'policy-denied',
      }),
    ]),
  );

  const allowed = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/left-pad',
    publishedAt: '2026-08-01T00:00:00Z',
    evaluationTime: '2026-08-04T00:00:00Z',
  });
  expect(allowed.decision).toBe('allow');
});

test('minimumReleaseAge missing publish time is not-provided unless strict', async () => {
  const soft = await evaluatePolicy(
    { ...baseSupply, minimumReleaseAgeMinutes: 60 },
    {
      evidence: [],
      lifecycle: eligible,
      evaluationTime: '2026-08-04T00:00:00Z',
    },
  );
  expect(soft.decision).toBe('indeterminate');
  expect(soft.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'supply-chain.release-age',
        status: 'not-provided',
      }),
    ]),
  );

  const hard = await evaluatePolicy(
    {
      ...baseSupply,
      minimumReleaseAgeMinutes: 60,
      minimumReleaseAgeStrict: true,
    },
    {
      evidence: [],
      lifecycle: eligible,
      evaluationTime: '2026-08-04T00:00:00Z',
    },
  );
  expect(hard.decision).toBe('deny');
});

test('minimumReleaseAge does not apply to local path sources', async () => {
  const result = await evaluatePolicy(
    { ...baseSupply, minimumReleaseAgeMinutes: 1440 },
    {
      evidence: [],
      lifecycle: eligible,
      sourceKind: 'path',
      evaluationTime: '2026-08-04T00:00:00Z',
    },
  );
  expect(result.decision).toBe('allow');
  expect(result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'supply-chain.release-age',
        status: 'valid',
        message: expect.stringMatching(/local path/i),
      }),
    ]),
  );
});

test('trustPolicy no-downgrade refuses unsigned after trusted-publisher', async () => {
  expect(TRUST_TIER_RANK['trusted-publisher']).toBeGreaterThan(
    TRUST_TIER_RANK.unsigned,
  );
  const policy: PolicyDocument = {
    ...baseSupply,
    trustPolicy: 'no-downgrade',
  };
  const denied = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/demo',
    trustLevel: 'unsigned',
    priorTrustLevel: 'trusted-publisher',
  });
  expect(denied.decision).toBe('deny');
  expect(denied.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'supply-chain.trust-no-downgrade',
        status: 'policy-denied',
      }),
    ]),
  );

  const ok = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/demo',
    trustLevel: 'provenance',
    priorTrustLevel: 'registry-attested',
  });
  expect(ok.decision).toBe('allow');
});

test('trustPolicy no-downgrade allows first install when priorTrustLevel is absent', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    trustPolicy: 'no-downgrade',
  };
  // Recommended production profile sets no-downgrade; first install has no lock prior.
  const first = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/demo@1.0.0',
    trustLevel: 'unsigned',
    // priorTrustLevel intentionally omitted
  });
  expect(first.decision).toBe('allow');
  expect(first.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'supply-chain.trust-no-downgrade',
        status: 'valid',
        message: expect.stringMatching(/first install/i),
      }),
    ]),
  );
});

test('blockExoticSources blocks transitive git/tarball but can allow direct', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    blockExoticSources: { transitive: true, direct: false },
  };
  const transitive = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    sourceKind: 'git',
    dependencyDepth: 2,
  });
  expect(transitive.decision).toBe('deny');

  const direct = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    sourceKind: 'git',
    dependencyDepth: 0,
  });
  expect(direct.decision).toBe('allow');
});

test('lifecycle script execution is denied unless allowlisted', async () => {
  const denied = await evaluatePolicy(
    { ...baseSupply, allowLifecycleScripts: false },
    {
      evidence: [],
      lifecycle: eligible,
      packageId: 'pkg:npm/evil',
      lifecycleScriptsExecuted: true,
    },
  );
  expect(denied.decision).toBe('deny');

  const allowlisted = await evaluatePolicy(
    {
      ...baseSupply,
      allowLifecycleScripts: false,
      allowedLifecycleScriptPackages: ['pkg:npm/esbuild'],
    },
    {
      evidence: [],
      lifecycle: eligible,
      packageId: 'pkg:npm/esbuild',
      lifecycleScriptsExecuted: true,
    },
  );
  expect(allowlisted.decision).toBe('allow');

  const declaredOnly = await evaluatePolicy(
    { ...baseSupply, allowLifecycleScripts: false },
    {
      evidence: [],
      lifecycle: eligible,
      packageId: 'pkg:npm/has-scripts',
      lifecycleScriptsDeclared: true,
      lifecycleScriptsExecuted: false,
    },
  );
  expect(declaredOnly.decision).toBe('allow');
});

test('registry pin refuses a different registry authority', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    expectedRegistryId: 'urn:openpacker:registry:npmjs-org',
  };
  const denied = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    registryId: 'urn:openpacker:registry:evil-mirror',
  });
  expect(denied.decision).toBe('deny');

  const ok = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    registryId: 'urn:openpacker:registry:npmjs-org',
  });
  expect(ok.decision).toBe('allow');
});

test('policyDocumentFromPolicyInput promotes normative schema knobs', async () => {
  const input: PolicyInput = {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'error',
    requiredEvidence: ['tuf'],
    minimumReleaseAgeMinutes: 1440,
    minimumReleaseAgeStrict: true,
    trustPolicy: 'no-downgrade',
    blockExoticSources: { transitive: true, direct: false },
    allowLifecycleScripts: false,
    expectedRegistryId: 'urn:openpacker:registry:npmjs-org',
    requireFreshTufMetadata: true,
    acceptedSignerIdentityPatterns: ['legacy@example.test'],
    sigstore: {
      required: true,
      issuerPatterns: ['https://issuer.example'],
      identityPatterns: ['release@example.test'],
      requireTransparencyEvidence: true,
    },
    slsa: {
      required: true,
      predicateTypes: ['https://slsa.dev/provenance/v1'],
      builderIds: ['https://builder.example'],
      buildTypes: ['https://build.example/npm'],
    },
    licenses: {
      allowed: ['MIT'],
      denied: ['GPL-3.0-only'],
      allowMissing: false,
      allowUnknown: false,
    },
    allowedTargets: [{ type: 'equals', path: '/os', value: 'linux' }],
    requiredSourceSnapshotDigests: [
      { algorithm: 'sha256', value: 'a'.repeat(64) },
    ],
  };
  const document = policyDocumentFromPolicyInput(input);
  expect(document.minimumReleaseAgeMinutes).toBe(1440);
  expect(document.trustPolicy).toBe('no-downgrade');
  expect(document.blockExoticSources?.transitive).toBe(true);
  expect(document.expectedRegistryId).toBe('urn:openpacker:registry:npmjs-org');
  expect(document.requiredEvidence).toEqual(
    expect.arrayContaining([
      'tuf',
      'tuf-fresh',
      'sigstore',
      'sigstore-transparency',
      'slsa',
      'slsa-predicate:https://slsa.dev/provenance/v1',
      'slsa-builder:https://builder.example',
      'slsa-build-type:https://build.example/npm',
    ]),
  );
  expect(document.allowedLicenses).toEqual(['MIT']);
  expect(document.allowedTargets).toEqual(input.allowedTargets);
  expect(document.acceptedIdentities).toEqual([
    'legacy@example.test',
    'release@example.test',
  ]);
  expect(document.requiredSourceSnapshotDigests).toEqual(
    input.requiredSourceSnapshotDigests,
  );
});

test('empty signer allowlists, deprecated defaults, and snapshot pins remain restrictive', async () => {
  const emptySigners = policyDocumentFromPolicyInput({
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    acceptedSignerIdentityPatterns: [],
  });
  expect(emptySigners.acceptedIdentities).toEqual([]);
  expect(
    (
      await evaluatePolicy(emptySigners, {
        evidence: [],
        lifecycle: eligible,
        signerIdentity: 'release@example.test',
      })
    ).decision,
  ).toBe('deny');

  expect(
    (
      await evaluatePolicy(
        {
          allowYanked: false,
          allowQuarantined: false,
          requiredEvidence: [],
          semanticLossMaximum: 'warning',
        },
        {
          evidence: [],
          lifecycle: { status: 'deprecated', eligible: true, warnings: [] },
        },
      )
    ).decision,
  ).toBe('allow');

  const pinned = policyDocumentFromPolicyInput({
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    requiredSourceSnapshotDigests: [
      { algorithm: 'sha256', value: 'a'.repeat(64) },
    ],
  });
  const mismatch = await evaluatePolicy(pinned, {
    evidence: [],
    lifecycle: eligible,
    sourceSnapshotDigests: [{ algorithm: 'sha256', value: 'b'.repeat(64) }],
  });
  expect(mismatch.decision).toBe('deny');
  expect(mismatch.checks).toContainEqual(
    expect.objectContaining({
      code: 'source-snapshot-digest',
      status: 'policy-denied',
    }),
  );
});

test('target predicates and configured evidence fail closed instead of disappearing', async () => {
  const document = policyDocumentFromPolicyInput({
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    requireFreshTufMetadata: true,
    allowedTargets: [{ type: 'equals', path: '/os', value: 'linux' }],
  });
  const missing = await evaluatePolicy(document, {
    evidence: [],
    lifecycle: eligible,
    target: { os: 'windows' },
  });
  expect(missing.decision).toBe('deny');
  expect(missing.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'evidence.tuf-fresh' }),
      expect.objectContaining({ code: 'target', status: 'policy-denied' }),
    ]),
  );

  const unsupported = await evaluatePolicy(
    {
      ...document,
      allowedTargets: [{ type: 'capabilityPresent', name: 'cpu:arm64' }],
    },
    {
      evidence: [{ type: 'tuf-fresh', status: 'verified' }],
      lifecycle: eligible,
    },
  );
  expect(unsupported.decision).toBe('indeterminate');
  expect(unsupported.checks).toContainEqual(
    expect.objectContaining({ code: 'target', status: 'not-provided' }),
  );
});

test('exclude lists stop at a coordinate boundary instead of matching siblings', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    minimumReleaseAgeMinutes: 1440,
    minimumReleaseAgeExclude: ['pkg:npm/left-pad'],
  };
  const facts = (packageId: string) => ({
    evidence: [],
    lifecycle: eligible,
    packageId,
    publishedAt: '2026-08-04T12:00:00Z',
    evaluationTime: '2026-08-04T18:00:00Z', // 6h < 24h
  });

  // The reviewed package is exempt, exact match and versioned form alike.
  expect(
    (await evaluatePolicy(policy, facts('pkg:npm/left-pad'))).decision,
  ).toBe('allow');
  expect(
    (await evaluatePolicy(policy, facts('pkg:npm/left-pad@1.3.0'))).decision,
  ).toBe('allow');

  // A package that merely starts with the same characters is a different
  // package and never got reviewed — the exemption must not reach it.
  expect(
    (await evaluatePolicy(policy, facts('pkg:npm/left-pad-installer')))
      .decision,
  ).toBe('deny');
});

test('an exclude entry ending on a boundary exempts the whole scope', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    minimumReleaseAgeMinutes: 1440,
    minimumReleaseAgeExclude: ['pkg:npm/@acme/'],
  };
  const facts = (packageId: string) => ({
    evidence: [],
    lifecycle: eligible,
    packageId,
    publishedAt: '2026-08-04T12:00:00Z',
    evaluationTime: '2026-08-04T18:00:00Z',
  });
  expect(
    (await evaluatePolicy(policy, facts('pkg:npm/@acme/widget@2.0.0')))
      .decision,
  ).toBe('allow');
  expect(
    (await evaluatePolicy(policy, facts('pkg:npm/@acme-evil/widget@2.0.0')))
      .decision,
  ).toBe('deny');
});

test('a lifecycle-script allowlist does not extend to look-alike names', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    allowLifecycleScripts: false,
    allowedLifecycleScriptPackages: ['pkg:npm/esbuild'],
  };
  const ran = (packageId: string) => ({
    evidence: [],
    lifecycle: eligible,
    packageId,
    lifecycleScriptsExecuted: true,
  });
  expect((await evaluatePolicy(policy, ran('pkg:npm/esbuild'))).decision).toBe(
    'allow',
  );
  expect(
    (await evaluatePolicy(policy, ran('pkg:npm/esbuild-postinstall'))).decision,
  ).toBe('deny');
});

test('a global allowLifecycleScripts flag is not an allowlist', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    allowLifecycleScripts: true,
    allowedLifecycleScriptPackages: [],
  };
  const decision = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/esbuild',
    lifecycleScriptsExecuted: true,
  });
  expect(decision.decision).toBe('deny');
});

test('sandbox fail-closed denies when scripts ran without an enforced jail', async () => {
  const policy: PolicyDocument = {
    ...baseSupply,
    allowLifecycleScripts: true,
    allowedLifecycleScriptPackages: ['pkg:npm/esbuild'],
    sandboxMode: 'fail-closed',
    sandboxRequired: true,
  };
  const denied = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/esbuild',
    lifecycleScriptsExecuted: true,
    sandboxEnforced: false,
    sandboxBackend: 'none',
  });
  expect(denied.decision).toBe('deny');
  expect(denied.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'sandbox.unavailable',
        status: 'policy-denied',
      }),
    ]),
  );

  const allowed = await evaluatePolicy(policy, {
    evidence: [],
    lifecycle: eligible,
    packageId: 'pkg:npm/esbuild',
    lifecycleScriptsExecuted: true,
    sandboxEnforced: true,
    sandboxBackend: 'native-bwrap',
  });
  expect(allowed.decision).toBe('allow');
});
