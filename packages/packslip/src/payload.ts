import {
  CanonicalJsonLimitError,
  documentParseLimits,
  parseCanonicalJson,
} from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';
import { PackslipError } from './errors.js';

/** A packslip is a statement plus a signature; a megabyte is far beyond either. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * What the JSON a signed bundle carries may cost to parse: as much as a
 * document of a bundle's bytes (`documentParseLimits`, 64 MiB). A signature
 * says who wrote a document, not that it is cheap to hold: the signer, or
 * whoever holds its key, chooses every byte, and the 3 MiB a bundle's payload
 * can be, all `{"1023":0}`, costs gigabytes to build (ADR 0044, "Documents
 * other than packuments").
 */
export const SIGNED_PAYLOAD_LIMITS = documentParseLimits(MAX_BUNDLE_BYTES);

/** A signed document refused for what it would cost to hold. */
export class SignedPayloadCostError extends PackslipError {
  constructor(readonly maximum: number) {
    super(
      'INVALID_STATEMENT',
      `The signed document would cost more than ${maximum} bytes to hold, which no document a bundle of ${MAX_BUNDLE_BYTES} bytes should carry`,
    );
    this.name = 'SignedPayloadCostError';
  }
}

/**
 * Parse the payload of a verified bundle (a release statement or a release
 * list) under `SIGNED_PAYLOAD_LIMITS`. The parse stops at the limit, before the
 * part past it is built.
 */
export function parseSignedPayload(payload: string): JsonValue {
  try {
    return parseCanonicalJson(payload, SIGNED_PAYLOAD_LIMITS);
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError && error.limit === 'cost')
      throw new SignedPayloadCostError(error.maximum);
    throw error;
  }
}
