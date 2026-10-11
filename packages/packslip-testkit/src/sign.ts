import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { JsonValue } from '@openpacker/contracts';

/** A throwaway Ed25519 key in the forms packslip consumers use. */
export interface TestKey {
  /** The minisign `.pub` file contents. */
  readonly publicKeyFile: string;
  readonly privateKey: KeyObject;
  /** Uppercase hexadecimal key id, as `packslip keygen` prints it. */
  readonly keyId: string;
  /** `base64(sha256(spki))`, the hint a bundle carries. */
  readonly hint: string;
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function generateTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(SPKI_PREFIX.length);
  const keyIdBytes = randomBytes(8);
  const keyId = Buffer.from(keyIdBytes).reverse().toString('hex').toUpperCase();
  const line = Buffer.concat([Buffer.from('Ed'), keyIdBytes, raw]).toString(
    'base64',
  );
  return {
    publicKeyFile: `untrusted comment: minisign public key ${keyId}\n${line}\n`,
    privateKey,
    keyId,
    hint: createHash('sha256').update(spki).digest('base64'),
  };
}

export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';

/** DSSE pre-authentication encoding. */
export function pae(payloadType: string, body: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${body.length} `,
    ),
    body,
  ]);
}

/** An unlogged, key-signed v0.3 bundle: what `packslip create --key --no-log` writes. */
export function signBundle(statement: JsonValue, key: TestKey): Uint8Array {
  const payload = Buffer.from(JSON.stringify(statement));
  const signature = sign(null, pae(PAYLOAD_TYPE, payload), key.privateKey);
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        publicKey: { hint: key.hint },
        tlogEntries: [],
        timestampVerificationData: {},
      },
      dsseEnvelope: {
        payload: payload.toString('base64'),
        payloadType: PAYLOAD_TYPE,
        signatures: [{ sig: signature.toString('base64') }],
      },
    }),
  );
}

/** Re-encode a bundle with a different DSSE payload, keeping the old signature. */
export function withPayload(
  bundle: Uint8Array,
  statement: JsonValue,
): Uint8Array {
  const parsed = JSON.parse(Buffer.from(bundle).toString('utf8'));
  parsed.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString(
    'base64',
  );
  return Buffer.from(JSON.stringify(parsed));
}
