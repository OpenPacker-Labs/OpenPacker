import type { JsonValue } from '@openpacker/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_BUNDLE_BYTES,
  SIGNED_PAYLOAD_LIMITS,
  SignedPayloadCostError,
  parseListPayload,
  parseSignedPayload,
  verifyBundle,
} from '../src/index.js';
import { generateTestKey, signBundle } from '@openpacker/packslip-testkit';

/**
 * A signed document is parsed under what an honest document of a bundle's
 * size may cost (ADR 0044, "Documents other than packuments"). The signature
 * says who wrote it, not that it is cheap to hold: `{"1023":0}` is 10 bytes
 * and an elements store of 40 KB, and a bundle may carry 3 MiB of it.
 */

// 120 KB of objects each named by an array index: 10,000 of them, which the
// parser charges 400 MB. Building them keeps about 125 MB, which a test can
// afford; a bundle's full 3 MiB would keep 3 GB.
const HOSTILE: JsonValue[] = Array.from({ length: 10_000 }, () => ({
  '1023': 0,
}));

function thrown(action: () => void): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(
      `a value that is not an Error was thrown: ${String(error)}`,
    );
  }
  throw new Error('the document was accepted');
}

describe('what a signed document may cost to hold', () => {
  it('is sixteen times the bytes of a bundle', () => {
    expect(MAX_BUNDLE_BYTES).toBe(4 * 1024 * 1024);
    expect(SIGNED_PAYLOAD_LIMITS).toEqual({ maximumCost: 64 * 1024 * 1024 });
  });

  it('refuses a release list payload that costs more, as a statement that is not one', () => {
    const error = thrown(() => parseListPayload(JSON.stringify(HOSTILE)));
    expect(error).toBeInstanceOf(SignedPayloadCostError);
    expect(error).toMatchObject({
      code: 'INVALID_STATEMENT',
      maximum: 64 * 1024 * 1024,
    });
    expect(error.message).toBe(
      'The signed document would cost more than 67108864 bytes to hold, which no document a bundle of 4194304 bytes should carry',
    );
  });

  it('reads a payload that does not', () => {
    const list = { project: 'github.com/acme/tool', releases: [] };
    expect(parseSignedPayload(JSON.stringify(list))).toEqual(list);
  });

  it('refuses a verified bundle whose statement costs more, saying so', () => {
    // The signature holds; what it signed is the refusal.
    const key = generateTestKey();
    const error = thrown(() =>
      verifyBundle({
        bundle: signBundle(HOSTILE, key),
        expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
        allowUnlogged: true,
      }),
    );
    expect(error).toBeInstanceOf(SignedPayloadCostError);
    expect(error.message).toMatch(/^The signed document would cost/u);
  });
});
