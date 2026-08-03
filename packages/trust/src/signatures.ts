import { canonicalBytes } from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';

const ED25519 = { name: 'Ed25519' } as const;

export interface Signer {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  sign(message: Uint8Array): Promise<string>;
}

export interface Verifier {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  verify(message: Uint8Array, signature: string): Promise<boolean>;
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(
    value
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  );
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    result[index] = binary.charCodeAt(index);
  return result;
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.byteLength);
  result.set(value);
  return result;
}

function base64url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

export class Ed25519Signer implements Signer {
  readonly algorithm = 'ed25519' as const;
  private constructor(
    readonly keyId: string,
    private readonly key: CryptoKey,
  ) {}

  static async fromJwk(keyId: string, jwk: JsonWebKey): Promise<Ed25519Signer> {
    if (
      !keyId ||
      jwk.kty !== 'OKP' ||
      jwk.crv !== 'Ed25519' ||
      !jwk.d ||
      !jwk.x
    )
      throw new TypeError('An Ed25519 private JWK and key ID are required');
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x, ext: false },
      ED25519,
      false,
      ['sign'],
    );
    return new Ed25519Signer(keyId, key);
  }

  async sign(message: Uint8Array): Promise<string> {
    return base64url(
      new Uint8Array(
        await crypto.subtle.sign(ED25519, this.key, copy(message)),
      ),
    );
  }
}

export class Ed25519Verifier implements Verifier {
  readonly algorithm = 'ed25519' as const;
  private constructor(
    readonly keyId: string,
    private readonly key: CryptoKey,
  ) {}

  static async fromJwk(
    keyId: string,
    jwk: JsonWebKey,
  ): Promise<Ed25519Verifier> {
    if (!keyId || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
      throw new TypeError('An Ed25519 public JWK and key ID are required');
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ext: false },
      ED25519,
      false,
      ['verify'],
    );
    return new Ed25519Verifier(keyId, key);
  }

  async verify(message: Uint8Array, signature: string): Promise<boolean> {
    try {
      return await crypto.subtle.verify(
        ED25519,
        this.key,
        bytes(signature),
        copy(message),
      );
    } catch {
      return false;
    }
  }
}

export async function signCanonical(
  value: JsonValue,
  signer: Signer,
): Promise<string> {
  return signer.sign(canonicalBytes(value));
}

export async function verifyCanonical(
  value: JsonValue,
  signature: string,
  verifier: Verifier,
): Promise<boolean> {
  return verifier.verify(canonicalBytes(value), signature);
}
