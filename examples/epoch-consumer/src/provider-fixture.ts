import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolutionUniverse, SignedReceipt } from '@openpacker/contracts';
import * as bindings from '@openpacker/embedded/wasm-node';
import { createEmbeddedResolver } from '@openpacker/embedded';
import { canonicalEventBytes, createCloudEvent } from '@openpacker/events';
import {
  createReferenceOperations,
  OperationError,
  SqliteStateStore,
  startOpenPackerDaemon,
  type OpenPackerStateStore,
} from '@openpacker/openpackerd';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';

export const EPOCH_PACT_RECEIPT_DIGEST =
  'a4724e0e132182679a559f9cf196762da523ea2c50ef61f3942c453cbbc0f735';

export async function seedEpochPactState(
  store: OpenPackerStateStore,
  workspaceRoot = findWorkspaceRoot(),
): Promise<void> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const signed = JSON.parse(
    await readFile(
      resolve(workspaceRoot, 'fixtures/epoch/signed-receipt.json'),
      'utf8',
    ),
  ) as SignedReceipt;
  const stored = await store.putReceipt(signed);
  if (stored !== `sha256:${EPOCH_PACT_RECEIPT_DIGEST}`)
    throw new Error('Epoch Pact receipt fixture digest drifted');
  const event = await createCloudEvent({
    type: 'org.openpacker.receipt.created',
    source: 'urn:openpacker:pact-provider',
    subject: stored,
    correlationId: 'epoch-pact',
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    data: { schemaVersion: '1', receiptDigest: signed.receiptDigest },
  });
  await store.appendEvent(event);
  if (canonicalEventBytes(event).byteLength === 0)
    throw new Error('Epoch Pact event fixture is empty');
}

export async function startEpochPactProvider(
  workspaceRoot = findWorkspaceRoot(),
) {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const keys = JSON.parse(
    await readFile(resolve(workspaceRoot, 'fixtures/trust/keys.json'), 'utf8'),
  ) as { root: JsonWebKey };
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const universe = JSON.parse(
    await readFile(
      resolve(workspaceRoot, 'fixtures/epoch/universe.json'),
      'utf8',
    ),
  ) as ResolutionUniverse;
  const signer = await Ed25519Signer.fromJwk('root', keys.root);
  const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
  const store = new SqliteStateStore(':memory:');
  await seedEpochPactState(store, workspaceRoot);
  const unavailable = async () => {
    throw new OperationError(
      'PROVIDER_CAPABILITY_MISSING',
      'The Pact fixture does not exercise this extension route',
    );
  };
  const operations = createReferenceOperations({
    universe,
    resolver: createEmbeddedResolver(bindings),
    meta: {
      protocolVersion: '1.0-draft',
      provider: {
        id: 'org.openpacker.reference',
        implementation: 'openpackerd',
        version: '0.1.0',
      },
    },
    resolverBuildDigest: { algorithm: 'sha256', value: 'f'.repeat(64) },
    receiptSigners: [signer],
    receiptVerifiers: new Map([[verifier.keyId, verifier]]),
    extensions: {
      lifecycleApply: unavailable,
      pack: unavailable,
      publish: unavailable,
    },
  });
  return startOpenPackerDaemon({ operations, store, port: 0 });
}

export function findWorkspaceRoot(): string {
  for (const levels of ['../../../', '../../../../']) {
    const candidate = fileURLToPath(new URL(levels, import.meta.url));
    if (existsSync(resolve(candidate, 'fixtures/epoch/signed-receipt.json')))
      return candidate;
  }
  throw new Error('Could not locate the OpenPacker workspace root');
}
