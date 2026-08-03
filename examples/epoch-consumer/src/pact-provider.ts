import { resolve } from 'node:path';
import { Verifier } from '@pact-foundation/pact';
import {
  EPOCH_PACT_RECEIPT_DIGEST,
  findWorkspaceRoot,
  startEpochPactProvider,
} from './provider-fixture.js';

export interface EpochPactProviderOptions {
  providerBaseUrl: string;
  pactFile?: string;
  prepareSignedReceipt?: () => Promise<{ receiptPath: string }>;
}

export async function verifyEpochPact(
  options: EpochPactProviderOptions,
): Promise<string> {
  const receiptPath = `/v1/receipts/sha256/${EPOCH_PACT_RECEIPT_DIGEST}`;
  return new Verifier({
    providerBaseUrl: options.providerBaseUrl,
    pactUrls: [
      options.pactFile ??
        resolve(
          findWorkspaceRoot(),
          'pacts/Epoch PREX Consumer-OpenPacker PREX Provider.json',
        ),
    ],
    logLevel: 'warn',
    stateHandlers: {
      'the PREX reference provider is ready': async () => undefined,
      'a deterministic PREX solve is available': async () => undefined,
      'receipt signature verification is configured': async () => undefined,
      'a signed receipt exists':
        options.prepareSignedReceipt ?? (async () => ({ receiptPath })),
      'a canonical OpenPacker event exists': async () => undefined,
    },
  }).verifyProvider();
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const local = process.env.OPENPACKER_URL
    ? undefined
    : await startEpochPactProvider();
  try {
    await verifyEpochPact({
      providerBaseUrl: process.env.OPENPACKER_URL ?? local!.address,
    });
  } finally {
    await local?.close();
  }
}
