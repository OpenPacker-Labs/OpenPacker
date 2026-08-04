import { expect, test } from 'vitest';
import {
  evaluatePolicy,
  TRUST_TIER_RANK,
  type PolicyDocument,
} from '../src/index.js';

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
