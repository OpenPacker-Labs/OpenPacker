import { expect, test } from 'vitest';
import { evaluatePolicy, type PolicyDocument } from '../src/index.js';

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
