import { expect, test } from 'vitest';
import { canonicalDigest } from '@openpacker/canonical';
import type {
  Digest,
  ResolutionReceipt,
  SolveRequest,
} from '@openpacker/contracts';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';
import keys from '../../../fixtures/trust/keys.json';
import {
  canonicalRequestDigest,
  rejectReceiptReplay,
  signReceipt,
  verifySignedReceipt,
} from '../src/index.js';

const digest = (character: string): Digest => ({
  algorithm: 'sha256',
  value: character.repeat(64),
});

async function receipt(): Promise<ResolutionReceipt> {
  const normalizedRequest: SolveRequest = {
    requirements: [],
    target: { os: 'linux', architecture: 'x86_64' },
    environment: { installed: [], locked: [] },
    policy: {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: ['receipt-signature'],
    },
    semantics: { profile: 'prex-calculus-subset-v1', nativeCompatibility: [] },
    objectives: ['satisfy-hard-constraints', 'canonical-lexical-tie-break'],
    mode: 'closure',
    evaluationTime: '2026-01-01T00:00:00Z',
    context: { idempotencyKey: 'receipt-fixture' },
  };
  return {
    receiptVersion: '1',
    protocolVersion: '1.0-draft',
    requestDigest: await canonicalRequestDigest(normalizedRequest),
    normalizedRequest,
    universeDigest: digest('2'),
    sourceSnapshots: [
      {
        snapshotId: 'fixture',
        providerId: 'fixture',
        providerType: 'offline',
        endpointIdentity: 'fixture:catalog',
        retrievedAt: '2026-01-01T00:00:00Z',
        evaluationTime: '2026-01-01T00:00:00Z',
        rootDigest: digest('3'),
        recordsDigest: digest('4'),
        evidenceRefs: [],
      },
    ],
    targetDigest: await canonicalDigest(normalizedRequest.target),
    policyDigest: await canonicalDigest(normalizedRequest.policy),
    lifecycleRoot: digest('5'),
    semanticsProfile: normalizedRequest.semantics.profile,
    objectiveOrdering: normalizedRequest.objectives,
    solutionDigest: digest('6'),
    proofDigest: digest('7'),
    explanationDigest: digest('8'),
    artifactSetDigest: digest('9'),
    resolver: {
      providerId: 'openpacker',
      implementation: 'fixture',
      version: '0.1.0',
      buildDigest: digest('a'),
    },
    evaluationTime: normalizedRequest.evaluationTime,
    evidenceRefs: [],
    externalRefs: [],
  };
}

test('canonical receipts sign their digest and reject replay', async () => {
  const signer = await Ed25519Signer.fromJwk('root', keys.root);
  const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
  const signed = await signReceipt(await receipt(), [signer]);
  await expect(
    verifySignedReceipt(signed, new Map([['root', verifier]])),
  ).resolves.toBeUndefined();
  const expected = {
    targetDigest: signed.receipt.targetDigest,
    policyDigest: signed.receipt.policyDigest,
    lifecycleRoot: signed.receipt.lifecycleRoot,
    universeDigest: signed.receipt.universeDigest,
    sourceSnapshotDigests: [
      signed.receipt.sourceSnapshots[0]!.rootDigest,
      signed.receipt.sourceSnapshots[0]!.recordsDigest,
    ],
    semanticsProfile: signed.receipt.semanticsProfile,
    objectiveOrdering: signed.receipt.objectiveOrdering,
    solutionDigest: signed.receipt.solutionDigest,
    resolverBuildDigest: signed.receipt.resolver.buildDigest,
  };
  expect(() => rejectReceiptReplay(signed.receipt, expected)).not.toThrow();
  expect(() =>
    rejectReceiptReplay(signed.receipt, {
      ...expected,
      targetDigest: digest('f'),
    }),
  ).toThrow('target');
  expect(() =>
    rejectReceiptReplay(
      {
        ...signed.receipt,
        sourceSnapshots: [
          ...signed.receipt.sourceSnapshots,
          {
            ...signed.receipt.sourceSnapshots[0]!,
            snapshotId: 'unexpected',
            rootDigest: digest('b'),
            recordsDigest: digest('c'),
          },
        ],
      },
      expected,
    ),
  ).toThrow('source-snapshots');
  const substituted = structuredClone(signed);
  substituted.receipt.solutionDigest = digest('e');
  await expect(
    verifySignedReceipt(substituted, new Map([['root', verifier]])),
  ).rejects.toThrow('digest mismatch');
  await expect(signReceipt(await receipt(), [])).rejects.toThrow('signer');
  await expect(
    signReceipt({ ...(await receipt()), requestDigest: digest('f') }, [signer]),
  ).rejects.toThrow('request digest');
});
