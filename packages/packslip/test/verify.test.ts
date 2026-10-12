import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { JsonValue } from '@openpacker/contracts';
import { describe, expect, it } from 'vitest';
import { parseCanonicalJson } from '@openpacker/canonical';
import {
  PackslipError,
  SIGSTORE_PUBLIC_GOOD_ROOT,
  SIGSTORE_PUBLIC_GOOD_ROOT_SHA256,
  decodeReleaseStatement,
  parseMinisignPublicKey,
  verifyBundle,
  type KeylessExpectation,
} from '../src/index.js';
import {
  generateTestKey,
  generateTestLog,
  signBundle,
  signLoggedBundle,
  withPayload,
} from '@openpacker/packslip-testkit';

const fixture = (path: string) =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const hk = fixture('real/hk-2.5.0.sigstore.json');
const self = fixture('real/packslip-1.5.1.sigstore.json');

const HK_PIN = 'ps1_snirenkjwr7m5ozgcufameodnm';
const hkExpectation: KeylessExpectation = {
  scheme: 'sigstore-oidc',
  issuer: 'https://token.actions.githubusercontent.com',
  identityPrefix: 'https://github.com/jdx/hk/',
};

function refusal(action: () => void): PackslipError {
  try {
    action();
  } catch (error) {
    if (error instanceof PackslipError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the embedded Sigstore trusted root', () => {
  it('is the exact TUF-authenticated target it claims to be', () => {
    expect(
      createHash('sha256').update(SIGSTORE_PUBLIC_GOOD_ROOT).digest('hex'),
    ).toBe(SIGSTORE_PUBLIC_GOOD_ROOT_SHA256);
  });
});

describe('verifying a real keyless bundle (jdx/hk 2.5.0, logged in Rekor)', () => {
  it('verifies offline and reports what the certificate records', () => {
    const verified = verifyBundle({ bundle: hk, expectation: hkExpectation });
    expect(verified.logged).toBe(true);
    expect(verified.integratedTime).toMatch(/^2026-10-0\d/u);
    expect(verified.signer).toMatchObject({
      scheme: 'sigstore-oidc',
      issuer: 'https://token.actions.githubusercontent.com',
      identity:
        'https://github.com/jdx/hk/.github/workflows/release.yml@refs/tags/v2.5.0',
      workflow: '.github/workflows/release.yml',
      repositoryUri: 'https://github.com/jdx/hk',
      repositoryId: '922514152',
      fingerprint: HK_PIN,
    });
    expect(verified.bundleDigest).toBe(
      `sha256:${createHash('sha256').update(hk).digest('hex')}`,
    );
  });

  it('yields a statement that decodes and names the expected release', () => {
    const verified = verifyBundle({ bundle: hk, expectation: hkExpectation });
    const statement = decodeReleaseStatement(
      parseCanonicalJson(verified.payload),
    );
    expect(statement.project).toBe('github.com/jdx/hk');
    expect(statement.version).toBe('2.5.0');
    expect(statement.identity.keyId).toBe(verified.signer.identity);
    expect(statement.artifacts.map((a) => a.name)).toContain(
      'hk-x86_64-unknown-linux-gnu.tar.gz',
    );
  });

  it('accepts the exact identity, the source repository, and the fingerprint', () => {
    for (const narrowing of [
      {
        identity:
          'https://github.com/jdx/hk/.github/workflows/release.yml@refs/tags/v2.5.0',
      },
      { sourceRepository: 'https://github.com/jdx/hk' },
      { pins: [HK_PIN] },
      { pins: ['ps1_kwhjac5qpc45qetfh6ppwisi6a', HK_PIN] },
    ])
      expect(() =>
        verifyBundle({
          bundle: hk,
          expectation: {
            scheme: 'sigstore-oidc',
            issuer: hkExpectation.issuer,
            ...narrowing,
          },
        }),
      ).not.toThrow();
  });

  it.each([
    ['another issuer', { issuer: 'https://gitlab.com' }, 'SIGNER_MISMATCH'],
    [
      'another repository prefix',
      { identityPrefix: 'https://github.com/jdx/mise/' },
      'SIGNER_MISMATCH',
    ],
    [
      'another exact identity',
      {
        identity:
          'https://github.com/jdx/hk/.github/workflows/other.yml@refs/tags/v2.5.0',
      },
      'SIGNER_MISMATCH',
    ],
    [
      'another source repository',
      { sourceRepository: 'https://github.com/jdx/mise' },
      'SIGNER_MISMATCH',
    ],
    [
      'another fingerprint',
      { pins: ['ps1_kwhjac5qpc45qetfh6ppwisi6a'] },
      'PIN_MISMATCH',
    ],
  ])('refuses a signer expectation for %s', (_label, change, code) => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: { ...hkExpectation, ...change },
        }),
      ).code,
    ).toBe(code);
  });

  it('refuses a malformed fingerprint rather than ignoring it', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: {
            ...hkExpectation,
            pins: ['ps2_snirenkjwr7m5ozgcufameodnm'],
          },
        }),
      ).code,
    ).toBe('INVALID_INPUT');
  });

  it('refuses an issuer-only expectation, which would accept any signer', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: {
            scheme: 'sigstore-oidc',
            issuer: hkExpectation.issuer,
          },
        }),
      ).code,
    ).toBe('INVALID_INPUT');
  });

  it('refuses a key expectation for a keyless release', () => {
    const key = generateTestKey();
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
        }),
      ).code,
    ).toBe('SIGNER_MISMATCH');
  });

  it('refuses a statement whose payload was changed after signing', () => {
    const verified = verifyBundle({ bundle: hk, expectation: hkExpectation });
    const statement = parseCanonicalJson(verified.payload);
    if (
      typeof statement !== 'object' ||
      statement === null ||
      Array.isArray(statement)
    )
      throw new Error('statement is an object');
    const tampered = withPayload(hk, { ...statement, extra: 1 });
    expect(
      refusal(() =>
        verifyBundle({ bundle: tampered, expectation: hkExpectation }),
      ).code,
    ).toBe('VERIFICATION_FAILED');
  });

  it('refuses a bundle with its log entries stripped, even if unlogged is allowed', () => {
    const stripped = JSON.parse(hk.toString('utf8'));
    stripped.verificationMaterial.tlogEntries = [];
    expect(
      refusal(() =>
        verifyBundle({
          bundle: Buffer.from(JSON.stringify(stripped)),
          expectation: hkExpectation,
          allowUnlogged: true,
        }),
      ).code,
    ).toBe('UNLOGGED');
  });

  it('refuses a trust root that does not contain the signing authority', () => {
    const empty = JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
      tlogs: [],
      certificateAuthorities: [],
      ctlogs: [],
      timestampAuthorities: [],
    });
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: hkExpectation,
          trustedRoot: empty,
        }),
      ).code,
    ).toBe('VERIFICATION_FAILED');
  });

  it('refuses an unreadable trust root as invalid input, not as a bad signature', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: hkExpectation,
          trustedRoot: '{',
        }),
      ).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('verifying the packslip project’s own release', () => {
  it('verifies against its workflow identity and signer fingerprint', () => {
    const verified = verifyBundle({
      bundle: self,
      expectation: {
        scheme: 'sigstore-oidc',
        issuer: 'https://token.actions.githubusercontent.com',
        identityPrefix:
          'https://github.com/jdx/packslip/.github/workflows/release.yml@',
        pins: ['ps1_mcx64bcghek2t4vljgb3lho3ti'],
      },
    });
    const statement = decodeReleaseStatement(
      parseCanonicalJson(verified.payload),
    );
    // The bundle's project is a domain, not a repository name, so the forge
    // name could never have authenticated it; the pin and identity do.
    expect(statement.project).toBe('packslip.dev');
    expect(verified.signer.repositoryId).toBe('1356006409');
  });
});

describe('verifying key-signed bundles', () => {
  const demoBundle = fixture('demo-key-signed/packslip.sigstore.json');
  const demoKey = fixture('demo-key-signed/demo.pub').toString('utf8');

  it('verifies a bundle written by the reference CLI when unlogged is allowed', () => {
    const verified = verifyBundle({
      bundle: demoBundle,
      expectation: { scheme: 'sigstore-key', publicKey: demoKey },
      allowUnlogged: true,
    });
    expect(verified.logged).toBe(false);
    expect(verified.integratedTime).toBeUndefined();
    expect(verified.signer).toEqual({
      scheme: 'sigstore-key',
      identity: '2FFD20AC43D16194',
      // The key itself, not only the label its file carries.
      keyHint: 'JBODpbviKQ/hBf/um+8eZ+exjExaXX5ziTuHz2W0+PA=',
    });
    const statement = decodeReleaseStatement(
      parseCanonicalJson(verified.payload),
    );
    expect(statement.identity).toMatchObject({
      scheme: 'sigstore-key',
      keyId: '2FFD20AC43D16194',
    });
  });

  it('accepts the bare base64 line as the pinned key', () => {
    const line = demoKey.split('\n')[1] ?? '';
    expect(() =>
      verifyBundle({
        bundle: demoBundle,
        expectation: { scheme: 'sigstore-key', publicKey: line },
        allowUnlogged: true,
      }),
    ).not.toThrow();
  });

  it('refuses an unlogged bundle unless that was allowed explicitly', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: demoBundle,
          expectation: { scheme: 'sigstore-key', publicKey: demoKey },
        }),
      ).code,
    ).toBe('UNLOGGED');
  });

  it('refuses a release signed by a different key', () => {
    const other = generateTestKey();
    expect(
      refusal(() =>
        verifyBundle({
          bundle: demoBundle,
          expectation: {
            scheme: 'sigstore-key',
            publicKey: other.publicKeyFile,
          },
          allowUnlogged: true,
        }),
      ).code,
    ).toBe('SIGNER_MISMATCH');
  });

  it('refuses a keyless expectation for a key-signed release', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: demoBundle,
          expectation: { ...hkExpectation },
          allowUnlogged: true,
        }),
      ).code,
    ).toBe('SIGNER_MISMATCH');
  });

  it('signs and verifies a fresh release made by the test signer', () => {
    const key = generateTestKey();
    const statement = {
      hello: 'world',
      predicate: { identity: { scheme: 'sigstore-key', key_id: key.keyId } },
    };
    const bundle = signBundle(statement, key);
    const verified = verifyBundle({
      bundle,
      expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
      allowUnlogged: true,
    });
    expect(JSON.parse(verified.payload)).toEqual(statement);
    expect(verified.signer.identity).toBe(key.keyId);
  });

  it('refuses a statement that declares a different signer than the key that signed it', () => {
    const key = generateTestKey();
    const declaring = (identity: { [key: string]: JsonValue }): JsonValue => ({
      predicate: { identity },
    });
    const verify = (statement: { [key: string]: JsonValue }) =>
      verifyBundle({
        bundle: signBundle(declaring(statement), key),
        expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
        allowUnlogged: true,
      });
    expect(() =>
      verify({ scheme: 'sigstore-key', key_id: key.keyId }),
    ).not.toThrow();
    for (const [identity, because] of [
      [
        { scheme: 'sigstore-key', key_id: 'DEADBEEFDEADBEEF' },
        /declares signer DEADBEEFDEADBEEF/u,
      ],
      [
        { scheme: 'sigstore-oidc', key_id: key.keyId },
        /declares a sigstore-oidc signature/u,
      ],
      [{ key_id: key.keyId }, /declares a missing signature/u],
      [{ scheme: 'sigstore-key' }, /declares signer \(none\)/u],
    ] as const)
      expect(refusal(() => verify(identity))).toMatchObject({
        code: 'SIGNER_MISMATCH',
        message: expect.stringMatching(because),
      });
  });

  it('refuses a signed document that declares no signer at all', () => {
    const key = generateTestKey();
    for (const document of [
      {},
      { predicate: {} },
      { predicate: { identity: 'nobody' } },
      [],
      'text',
    ])
      expect(
        refusal(() =>
          verifyBundle({
            bundle: signBundle(document, key),
            expectation: {
              scheme: 'sigstore-key',
              publicKey: key.publicKeyFile,
            },
            allowUnlogged: true,
          }),
        ).code,
      ).toBe('INVALID_STATEMENT');
  });

  it('refuses a payload altered after signing', () => {
    const key = generateTestKey();
    const declare = (n: number) => ({
      n,
      predicate: { identity: { scheme: 'sigstore-key', key_id: key.keyId } },
    });
    const bundle = signBundle(declare(1), key);
    expect(
      refusal(() =>
        verifyBundle({
          bundle: withPayload(bundle, declare(2)),
          expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
          allowUnlogged: true,
        }),
      ).code,
    ).toBe('VERIFICATION_FAILED');
  });
});

describe('malformed bundles', () => {
  const expectation = hkExpectation;
  it.each([
    ['not JSON', Buffer.from('nope')],
    ['an empty object', Buffer.from('{}')],
    ['an array', Buffer.from('[]')],
    ['empty input', Buffer.alloc(0)],
  ])('refuses %s as an invalid bundle', (_label, bundle) => {
    expect(refusal(() => verifyBundle({ bundle, expectation })).code).toBe(
      'INVALID_BUNDLE',
    );
  });

  it('refuses an oversized bundle before parsing it', () => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: Buffer.alloc(5 * 1024 * 1024, 0x20),
          expectation,
        }),
      ).code,
    ).toBe('INVALID_BUNDLE');
  });

  it('refuses a message-signature bundle: a packslip is a DSSE envelope', () => {
    const parsed = JSON.parse(hk.toString('utf8'));
    delete parsed.dsseEnvelope;
    parsed.messageSignature = {
      messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
      signature: 'AAAA',
    };
    expect(
      refusal(() =>
        verifyBundle({
          bundle: Buffer.from(JSON.stringify(parsed)),
          expectation,
        }),
      ).code,
    ).toBe('INVALID_BUNDLE');
  });

  it('refuses an envelope with another payload type', () => {
    const parsed = JSON.parse(hk.toString('utf8'));
    parsed.dsseEnvelope.payloadType = 'text/plain';
    expect(
      refusal(() =>
        verifyBundle({
          bundle: Buffer.from(JSON.stringify(parsed)),
          expectation,
        }),
      ).code,
    ).toBe('INVALID_BUNDLE');
  });

  it('rejects a pinned key that is not a minisign Ed25519 key', () => {
    for (const bad of ['', 'untrusted comment: x\n', 'AAAA', 'RWQ='])
      expect(() => parseMinisignPublicKey(bad)).toThrow(PackslipError);
  });
});

describe('the time a signature is proven to exist', () => {
  const statement = (keyId: string): JsonValue => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [],
    predicateType: 'https://packslip.dev/release/v1',
    predicate: { identity: { scheme: 'sigstore-key', key_id: keyId } },
  });
  const key = generateTestKey();
  const log = generateTestLog();
  const expectation = {
    scheme: 'sigstore-key' as const,
    publicKey: key.publicKeyFile,
  };

  it('is the time the log signed for a logged key-signed bundle', () => {
    const at = new Date('2026-10-01T08:30:00Z');
    const verified = verifyBundle({
      bundle: signLoggedBundle(statement(key.keyId), key, log, at),
      expectation,
      trustedRoot: log.trustedRoot,
    });
    expect(verified.logged).toBe(true);
    expect(verified.integratedTime).toBe('2026-10-01T08:30:00.000Z');
    expect(verified.signer.keyHint).toBe(key.hint);
  });

  it('refuses an entry whose time was changed after the log signed it', () => {
    // A signer who wants a release to look old rewrites the entry's time.
    const forged = signLoggedBundle(
      statement(key.keyId),
      key,
      log,
      new Date('2026-10-01T08:30:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    );
    expect(
      refusal(() =>
        verifyBundle({
          bundle: forged,
          expectation,
          trustedRoot: log.trustedRoot,
        }),
      ).code,
    ).toBe('VERIFICATION_FAILED');
  });

  it('does not trust a log the root does not name', () => {
    const bundle = signLoggedBundle(
      statement(key.keyId),
      key,
      generateTestLog(),
      new Date('2026-10-01T08:30:00Z'),
    );
    expect(
      refusal(() =>
        verifyBundle({ bundle, expectation, trustedRoot: log.trustedRoot }),
      ).code,
    ).toBe('VERIFICATION_FAILED');
  });

  it('is absent for an unlogged bundle, and never the statement’s own published_at', () => {
    const verified = verifyBundle({
      bundle: signBundle(
        {
          ...(statement(key.keyId) as Record<string, JsonValue>),
          predicate: {
            identity: { scheme: 'sigstore-key', key_id: key.keyId },
            published_at: '2020-01-01T00:00:00Z',
          },
        },
        key,
      ),
      expectation,
      allowUnlogged: true,
    });
    expect(verified.logged).toBe(false);
    expect(verified.integratedTime).toBeUndefined();
  });

  it('ignores a log entry whose time no signed timestamp covers', () => {
    // Rekor v2 entries carry a proof and no signed entry timestamp; their
    // integration time is plain JSON a forger can write. Adding such an entry
    // beside the honest one must not move the time the verifier reports.
    const honest = verifyBundle({ bundle: hk, expectation: hkExpectation });
    const bundle = JSON.parse(hk.toString('utf8'));
    const entry = structuredClone(bundle.verificationMaterial.tlogEntries[0]);
    delete entry.inclusionPromise;
    entry.integratedTime = '1';
    bundle.verificationMaterial.tlogEntries.push(entry);
    const forged = verifyBundle({
      bundle: Buffer.from(JSON.stringify(bundle)),
      expectation: hkExpectation,
    });
    expect(forged.integratedTime).toBe(honest.integratedTime);
  });
});

describe('an expectation must say who may sign', () => {
  it.each([
    ['an empty identity prefix', { identityPrefix: '' }],
    ['an empty identity', { identity: '' }],
    ['an empty source repository', { sourceRepository: '' }],
    ['no fingerprints', { pins: [] }],
  ])('refuses %s: it narrows nothing', (_name, narrowing) => {
    expect(
      refusal(() =>
        verifyBundle({
          bundle: hk,
          expectation: {
            scheme: 'sigstore-oidc',
            issuer: 'https://token.actions.githubusercontent.com',
            ...narrowing,
          },
        }),
      ).code,
    ).toBe('INVALID_INPUT');
  });
});
