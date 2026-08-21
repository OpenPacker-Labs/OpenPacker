import {
  canonicalBytes,
  canonicalDigest,
  canonicalProjectionDigest,
  compareCanonicalStrings,
  formatDigest,
} from '@openpacker/canonical';
import {
  DIGEST_PROJECTIONS,
  type Digest,
  type JsonValue,
  type ResolutionReceipt,
  type SignedReceipt,
  type SolveRequest,
} from '@openpacker/contracts';
import type { Signer, Verifier } from '@openpacker/trust';

export interface ReceiptReplayContext {
  targetDigest: Digest;
  policyDigest: Digest;
  lifecycleRoot: Digest;
  universeDigest: Digest;
  sourceSnapshotDigests: Digest[];
  semanticsProfile: ResolutionReceipt['semanticsProfile'];
  objectiveOrdering: ResolutionReceipt['objectiveOrdering'];
  solutionDigest: Digest;
  resolverBuildDigest: Digest;
}

const equal = (left: Digest, right: Digest): boolean =>
  left.algorithm === right.algorithm && left.value === right.value;

export async function canonicalRequestDigest(
  request: SolveRequest,
): Promise<Digest> {
  const projection = DIGEST_PROJECTIONS.projections.find(
    ({ id }) => id === 'request-v1',
  );
  if (!projection) throw new Error('Missing request-v1 digest projection');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalProjectionDigest(request as unknown as JsonValue, projection);
}

export async function validateReceiptBindings(
  receipt: ResolutionReceipt,
): Promise<void> {
  const request = await canonicalRequestDigest(receipt.normalizedRequest);
  const target = await canonicalDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    receipt.normalizedRequest.target as unknown as JsonValue,
  );
  const policy = await canonicalDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    receipt.normalizedRequest.policy as unknown as JsonValue,
  );
  if (!equal(receipt.requestDigest, request))
    throw new Error(
      'Receipt request digest does not bind the normalized request',
    );
  if (!equal(receipt.targetDigest, target))
    throw new Error(
      'Receipt target digest does not bind the normalized target',
    );
  if (!equal(receipt.policyDigest, policy))
    throw new Error(
      'Receipt policy digest does not bind the normalized policy',
    );
  if (receipt.semanticsProfile !== receipt.normalizedRequest.semantics.profile)
    throw new Error('Receipt semantics profile mismatch');
  if (
    JSON.stringify(receipt.objectiveOrdering) !==
    JSON.stringify(receipt.normalizedRequest.objectives)
  )
    throw new Error('Receipt objective ordering mismatch');
  if (receipt.evaluationTime !== receipt.normalizedRequest.evaluationTime)
    throw new Error('Receipt evaluation time mismatch');
  if (!receipt.sourceSnapshots.length || !receipt.resolver.buildDigest.value)
    throw new Error(
      'Receipt source snapshots and resolver build evidence are required',
    );
}

export async function signReceipt(
  receipt: ResolutionReceipt,
  signers: readonly Signer[],
): Promise<SignedReceipt> {
  await validateReceiptBindings(receipt);
  if (!signers.length)
    throw new Error('At least one receipt signer is required');
  if (new Set(signers.map((signer) => signer.keyId)).size !== signers.length)
    throw new Error('Receipt signer key IDs must be unique');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const receiptDigest = await canonicalDigest(receipt as unknown as JsonValue);
  const message = new TextEncoder().encode(formatDigest(receiptDigest));
  const signatures = await Promise.all(
    signers.map(async (signer) => ({
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      signature: await signer.sign(message),
    })),
  );
  return {
    receipt,
    receiptDigest,
    signatures: signatures.sort((left, right) =>
      compareCanonicalStrings(left.keyId, right.keyId),
    ),
  };
}

export async function verifySignedReceipt(
  signed: SignedReceipt,
  verifiers: ReadonlyMap<string, Verifier>,
): Promise<void> {
  await validateReceiptBindings(signed.receipt);
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const digest = await canonicalDigest(signed.receipt as unknown as JsonValue);
  if (!equal(digest, signed.receiptDigest))
    throw new Error('Receipt digest mismatch');
  const message = new TextEncoder().encode(formatDigest(digest));
  if (!signed.signatures.length) throw new Error('Receipt has no signatures');
  for (const signature of signed.signatures) {
    const verifier = verifiers.get(signature.keyId);
    if (
      !verifier ||
      verifier.algorithm !== signature.algorithm ||
      !(await verifier.verify(message, signature.signature))
    )
      throw new Error(`Invalid receipt signature: ${signature.keyId}`);
  }
}

export function rejectReceiptReplay(
  receipt: ResolutionReceipt,
  expected: ReceiptReplayContext,
): void {
  const mismatches: string[] = [];
  const check = (name: string, actual: Digest, wanted: Digest) => {
    if (!equal(actual, wanted)) mismatches.push(name);
  };
  check('target', receipt.targetDigest, expected.targetDigest);
  check('policy', receipt.policyDigest, expected.policyDigest);
  check('lifecycle', receipt.lifecycleRoot, expected.lifecycleRoot);
  check('universe', receipt.universeDigest, expected.universeDigest);
  check('solution', receipt.solutionDigest, expected.solutionDigest);
  check(
    'resolver-build',
    receipt.resolver.buildDigest,
    expected.resolverBuildDigest,
  );
  if (receipt.semanticsProfile !== expected.semanticsProfile)
    mismatches.push('semantics');
  if (
    JSON.stringify(receipt.objectiveOrdering) !==
    JSON.stringify(expected.objectiveOrdering)
  )
    mismatches.push('objectives');
  const sources = new Set(
    receipt.sourceSnapshots.flatMap((snapshot) => [
      formatDigest(snapshot.rootDigest),
      formatDigest(snapshot.recordsDigest),
    ]),
  );
  const expectedSources = new Set(
    expected.sourceSnapshotDigests.map(formatDigest),
  );
  if (
    sources.size !== expectedSources.size ||
    [...sources].some((digest) => !expectedSources.has(digest))
  )
    mismatches.push('source-snapshots');
  if (mismatches.length)
    throw new Error(
      `Receipt replay context mismatch: ${mismatches.join(', ')}`,
    );
}

export function canonicalReceiptBytes(receipt: ResolutionReceipt): Uint8Array {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalBytes(receipt as unknown as JsonValue);
}
