export * from './generated.js';

export const PREX_PROTOCOL_VERSION = '1.0-draft' as const;

export const PREX_CONFORMANCE_LEVELS = [
  'PREX-N',
  'PREX-I',
  'PREX-E',
  'PREX-D',
  'PREX-S',
  'PREX-M',
  'PREX-V',
  'PREX-X',
  'PREX-R',
  'PREX-C',
] as const;

export const MEDIA_TYPES = {
  packageMetadata: 'application/vnd.openpacker.package.metadata.v1+json',
  receipt: 'application/vnd.openpacker.prex.receipt.v1+json',
  overlay: 'application/vnd.openpacker.overlay.v1+json',
  chunkIndex: 'application/vnd.openpacker.chunk-index.v1+json',
  lifecycle: 'application/vnd.openpacker.lifecycle.v1+json',
  explanation: 'application/vnd.openpacker.explanation.v1+json',
  proof: 'application/vnd.openpacker.proof.v1+json',
  lockfile: 'application/vnd.openpacker.lock.v1+json',
  normalizedPack: 'application/vnd.openpacker.normalized-pack.v1+json',
  packReceipt: 'application/vnd.openpacker.pack-receipt.v1+json',
  delegatedPackProvider:
    'application/vnd.openpacker.delegated-pack-provider.v1+json',
  delegatedAdapter: 'application/vnd.openpacker.delegated-adapter.v1+json',
  problem: 'application/problem+json',
} as const;
