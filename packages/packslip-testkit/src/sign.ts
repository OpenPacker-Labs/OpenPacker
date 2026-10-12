import {
  createHash,
  createPublicKey,
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

/**
 * A throwaway transparency log: a signing key and the Sigstore trusted root
 * that trusts it. Pass `trustedRoot` where a verifier takes one. It has no
 * certificate authority, so it can verify key-signed bundles only.
 */
export interface TestLog {
  readonly privateKey: KeyObject;
  readonly trustedRoot: string;
  /** base64 of the log's key id, as a bundle's `logId.keyId` carries it. */
  readonly keyId: string;
}

export function generateTestLog(): TestLog {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(spki).digest('base64');
  const trustedRoot = JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    tlogs: [
      {
        baseUrl: 'https://log.test.invalid',
        hashAlgorithm: 'SHA2_256',
        publicKey: {
          rawBytes: spki.toString('base64'),
          keyDetails: 'PKIX_ECDSA_P256_SHA_256',
          validFor: { start: '2020-01-01T00:00:00Z' },
        },
        logId: { keyId },
      },
    ],
    certificateAuthorities: [],
    ctlogs: [],
    timestampAuthorities: [],
  });
  return { privateKey, trustedRoot, keyId };
}

/**
 * A key-signed bundle that `log` recorded at `integratedTime`, with the signed
 * entry timestamp a real Rekor writes. `claimedTime` writes a different time
 * into the entry *without* re-signing it, which is what a forger can do: the
 * entry then fails verification, as it should.
 */
export function signLoggedBundle(
  statement: JsonValue,
  key: TestKey,
  log: TestLog,
  integratedTime: Date,
  claimedTime?: Date,
): Uint8Array {
  const payload = Buffer.from(JSON.stringify(statement));
  const signature = sign(null, pae(PAYLOAD_TYPE, payload), key.privateKey);
  const publicKeyPem = createPublicKey(key.privateKey)
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const body = Buffer.from(
    JSON.stringify({
      apiVersion: '0.0.1',
      kind: 'dsse',
      spec: {
        payloadHash: {
          algorithm: 'sha256',
          value: createHash('sha256').update(payload).digest('hex'),
        },
        signatures: [
          {
            signature: signature.toString('base64'),
            verifier: Buffer.from(publicKeyPem).toString('base64'),
          },
        ],
      },
    }),
  );
  const seconds = Math.floor(integratedTime.getTime() / 1000);
  const logIndex = 0;
  // A one-leaf tree: the root is the leaf's RFC 6962 hash, the proof has no
  // siblings, and the checkpoint is the log's signed note over that root. A
  // v0.3 bundle must carry the proof (the entry's time is covered by the SET
  // above; the proof only places the entry in the log).
  const root = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), body]))
    .digest();
  const origin = 'log.test.invalid';
  const note = `${origin}\n1\n${root.toString('base64')}\n`;
  const checkpointSignature = sign('sha256', Buffer.from(note), log.privateKey);
  const envelope = `${note}\n\u2014 ${origin} ${Buffer.concat([
    Buffer.from(log.keyId, 'base64').subarray(0, 4),
    checkpointSignature,
  ]).toString('base64')}\n`;
  // The signed payload is Rekor's, canonicalized with sorted keys.
  const set = sign(
    'sha256',
    Buffer.from(
      JSON.stringify({
        body: body.toString('base64'),
        integratedTime: seconds,
        logID: Buffer.from(log.keyId, 'base64').toString('hex'),
        logIndex,
      }),
    ),
    log.privateKey,
  );
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        publicKey: { hint: key.hint },
        tlogEntries: [
          {
            logIndex: String(logIndex),
            logId: { keyId: log.keyId },
            kindVersion: { kind: 'dsse', version: '0.0.1' },
            integratedTime: String(
              Math.floor((claimedTime ?? integratedTime).getTime() / 1000),
            ),
            inclusionPromise: { signedEntryTimestamp: set.toString('base64') },
            inclusionProof: {
              logIndex: String(logIndex),
              rootHash: root.toString('base64'),
              treeSize: '1',
              hashes: [],
              checkpoint: { envelope },
            },
            canonicalizedBody: body.toString('base64'),
          },
        ],
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
