import { expect, test } from 'vitest';
import { evaluatePolicy, type PolicyDocument } from '../src/index.js';

/**
 * When a version's publish time cannot be had the policy says it was not
 * captured. If the registry's document was refused, that is the reason, and a
 * person reading "not captured" needs it beside the words.
 */

const policy: PolicyDocument = {
  allowYanked: false,
  allowQuarantined: false,
  requiredEvidence: [],
  semanticLossMaximum: 'warning',
  minimumReleaseAgeMinutes: 1440,
};

const facts = {
  evidence: [],
  lifecycle: {
    status: 'published' as const,
    eligible: true,
    warnings: [] as string[],
  },
  packageId: 'pkg:npm/example-heavy@1.0.0',
  evaluationTime: '2026-10-12T12:00:00Z',
};

const releaseAge = (
  result: Awaited<ReturnType<typeof evaluatePolicy>>,
): { status: string; message: string } | undefined =>
  result.checks.find((check) => check.code === 'supply-chain.release-age');

const why =
  'The full packument of example-heavy is 100663297 bytes (96.00 MiB) and exceeds the limit of 100663296 bytes (96.00 MiB)';

test('a refused document is named beside "not captured"', async () => {
  const result = await evaluatePolicy(policy, {
    ...facts,
    publishTimeUnavailable: why,
  });
  expect(result.decision).toBe('indeterminate');
  expect(releaseAge(result)).toMatchObject({
    status: 'not-provided',
    message: `publishedAt/evaluationTime not captured for minimum release age: ${why}`,
  });
});

test('and beside the strict form of the same refusal', async () => {
  const result = await evaluatePolicy(
    { ...policy, minimumReleaseAgeStrict: true },
    { ...facts, publishTimeUnavailable: why },
  );
  expect(result.decision).toBe('deny');
  expect(releaseAge(result)?.message).toBe(
    `minimumReleaseAge is strict but publishedAt/evaluationTime was not captured: ${why}`,
  );
});

test('a registry that was only silent keeps the message it always had', async () => {
  const result = await evaluatePolicy(policy, facts);
  expect(releaseAge(result)?.message).toBe(
    'publishedAt/evaluationTime not captured for minimum release age',
  );
});

test('a reason changes nothing once there is a time', async () => {
  const result = await evaluatePolicy(policy, {
    ...facts,
    publishedAt: '2026-01-01T00:00:00Z',
    publishTimeUnavailable: why,
  });
  expect(result.decision).toBe('allow');
});
