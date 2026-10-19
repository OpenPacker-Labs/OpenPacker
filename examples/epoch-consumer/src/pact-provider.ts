import { isIPv4 } from 'node:net';
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
  logLevel?: 'error' | 'warn';
  prepareSignedReceipt?: () => Promise<{ receiptPath: string }>;
}

export async function verifyEpochPact(
  options: EpochPactProviderOptions,
): Promise<string> {
  const receiptPath = `/v1/receipts/sha256/${EPOCH_PACT_RECEIPT_DIGEST}`;
  const verifier = new Verifier({
    providerBaseUrl: options.providerBaseUrl,
    pactUrls: [
      options.pactFile ??
        resolve(
          findWorkspaceRoot(),
          'pacts/Epoch PREX Consumer-OpenPacker PREX Provider.json',
        ),
    ],
    logLevel: options.logLevel ?? 'warn',
    stateHandlers: {
      'the PREX reference provider is ready': async () => undefined,
      'a deterministic PREX solve is available': async () => undefined,
      'receipt signature verification is configured': async () => undefined,
      'a signed receipt exists':
        options.prepareSignedReceipt ?? (async () => ({ receiptPath })),
      'a canonical OpenPacker event exists': async () => undefined,
    },
  });
  return withoutProxyForLoopback(options.providerBaseUrl, () =>
    verifier.verifyProvider(),
  );
}

/**
 * The variables the Pact verifier's provider proxy reads. It sends every
 * provider request through `HTTPS_PROXY || HTTP_PROXY` with an
 * `HttpsProxyAgent` and never consults NO_PROXY
 * (`@pact-foundation/pact` `dsl/verifier/proxy/proxyRequest.js`).
 * NO_PROXY is not enough: Pact 17.0.1's proxyRequest.js ignores it, so a
 * loopback provider listed there is still asked through the proxy.
 */
const PACT_PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY'] as const;
let hidden: { holders: number; saved: Record<string, string> } | undefined;

/**
 * Runs `run` with the proxy the Pact verifier reads hidden from this process
 * when `url` is a loopback address, and puts it back once the last such run
 * ends. A proxy elsewhere cannot reach this host's loopback, so a loopback
 * provider is asked directly; any other provider keeps the proxy.
 */
export async function withoutProxyForLoopback<T>(
  url: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLoopback(url)) return run();
  if (hidden === undefined) {
    const saved: Record<string, string> = {};
    for (const name of PACT_PROXY_VARIABLES) {
      const value = process.env[name];
      if (value !== undefined) saved[name] = value;
      delete process.env[name];
    }
    hidden = { holders: 0, saved };
  }
  const held = hidden;
  held.holders += 1;
  try {
    return await run();
  } finally {
    held.holders -= 1;
    if (held.holders === 0) {
      Object.assign(process.env, held.saved);
      hidden = undefined;
    }
  }
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/u, '$1');
  return (
    host === 'localhost' ||
    host === '::1' ||
    (isIPv4(host) && host.startsWith('127.'))
  );
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
