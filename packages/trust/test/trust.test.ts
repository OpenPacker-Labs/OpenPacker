import { describe, expect, test } from 'vitest';
import keys from '../../../fixtures/trust/keys.json';
import { canonicalBytes, sha256 } from '@openpacker/canonical';
import {
  Ed25519Signer,
  Ed25519Verifier,
  cycloneDxEvidenceStatus,
  extractCycloneDxEvidence,
  verifyCanonical,
  verifyOfflineSigstoreBundle,
  verifyRootRotation,
  verifySlsaProvenance,
  verifyTufTarget,
  type OfflineSigstoreBundle,
  type RootMetadata,
  type SignedMetadata,
  type SnapshotMetadata,
  type TargetsMetadata,
  type TimestampMetadata,
  type TufKey,
} from '../src/index.js';

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const key = (x: string): TufKey => ({
  keytype: 'ed25519',
  scheme: 'ed25519',
  keyval: { public: x },
});

async function signer(name: 'root' | 'leaf' | 'log') {
  return Ed25519Signer.fromJwk(name, keys[name]);
}
async function signed<
  T extends
    | RootMetadata
    | TimestampMetadata
    | SnapshotMetadata
    | TargetsMetadata,
>(
  value: T,
  supplied?: Array<Awaited<ReturnType<typeof signer>>>,
): Promise<SignedMetadata<T>> {
  const signers = supplied ?? [await signer('root')];
  return {
    signed: value,
    signatures: await Promise.all(
      signers.map(async (item) => ({
        keyid: item.keyId,
        sig: await item.sign(canonicalBytes(value as never)),
      })),
    ),
  };
}
async function file(value: unknown, version: number) {
  const bytes = encode(value);
  return {
    bytes,
    meta: {
      version,
      length: bytes.length,
      hashes: { sha256: (await sha256(bytes)).value },
    },
  };
}

async function tufFixture(
  options: {
    /** Target path the delegated role actually signs for. */
    targetPath?: string;
    /** Delegation scope declared on the role in targets.json. */
    paths?: string[];
    pathHashPrefixes?: string[];
  } = {},
) {
  const targetPath = options.targetPath ?? 'tools/demo.bin';
  const targetBytes = new TextEncoder().encode('fixture artifact\n');
  const targetDigest = await sha256(targetBytes);
  const delegated = await signed<TargetsMetadata>({
    _type: 'targets',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    targets: {
      [targetPath]: {
        length: targetBytes.length,
        hashes: { sha256: targetDigest.value },
      },
    },
  });
  const delegatedFile = await file(delegated, 1);
  const targets = await signed<TargetsMetadata>({
    _type: 'targets',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    targets: {},
    delegations: {
      keys: { root: key(keys.root.x) },
      roles: [
        {
          name: 'tools',
          keyids: ['root'],
          threshold: 1,
          ...(options.pathHashPrefixes
            ? { path_hash_prefixes: options.pathHashPrefixes }
            : { paths: options.paths ?? ['tools/*'] }),
          terminating: true,
        },
      ],
    },
  });
  const targetsFile = await file(targets, 1);
  const snapshot = await signed<SnapshotMetadata>({
    _type: 'snapshot',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    meta: {
      'targets.json': targetsFile.meta,
      'tools.json': delegatedFile.meta,
    },
  });
  const snapshotFile = await file(snapshot, 1);
  const timestamp = await signed<TimestampMetadata>({
    _type: 'timestamp',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    meta: { 'snapshot.json': snapshotFile.meta },
  });
  const root = await signed<RootMetadata>({
    _type: 'root',
    spec_version: '1.0.31',
    version: 1,
    expires: '2028-01-01T00:00:00Z',
    consistent_snapshot: true,
    keys: { root: key(keys.root.x) },
    roles: Object.fromEntries(
      ['root', 'timestamp', 'snapshot', 'targets'].map((role) => [
        role,
        { keyids: ['root'], threshold: 1 },
      ]),
    ),
  });
  return {
    trusted: {
      root,
      timestampVersion: 0,
      snapshotVersion: 0,
      metadataVersions: {},
    },
    targetPath,
    targetBytes,
    files: {
      timestamp: encode(timestamp),
      snapshot: snapshotFile.bytes,
      targets: targetsFile.bytes,
      targetsFileName: '1.targets.json',
      delegated: { tools: delegatedFile.bytes },
      delegatedFileNames: { tools: '1.tools.json' },
    },
  };
}

describe('TUF delegation scope', () => {
  test('a role scoped to tools/* cannot sign for a nested path', async () => {
    // TUF matches path patterns per segment with equal segment counts, so
    // `tools/*` delegates the tools directory and not everything under it.
    // Prefix matching would hand this role authority it was never granted.
    const fixture = await tufFixture({
      targetPath: 'tools/vendor/backdoor.bin',
    });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        fixture.files,
        fixture.targetPath,
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'target' });
  });

  test('honours a wildcard pattern that is not a trailing /*', async () => {
    for (const paths of [['*'], ['tools/*.bin'], ['tools/demo.?in']]) {
      const fixture = await tufFixture({
        targetPath: paths[0] === '*' ? 'demo.bin' : 'tools/demo.bin',
        paths,
      });
      await expect(
        verifyTufTarget(
          fixture.trusted,
          fixture.files,
          fixture.targetPath,
          fixture.targetBytes,
          '2026-01-01T00:00:00Z',
        ),
      ).resolves.toMatchObject({ role: 'tools' });
    }
  });

  test('resolves a delegation declared by path hash prefix', async () => {
    const targetPath = 'tools/demo.bin';
    const hash = (await sha256(new TextEncoder().encode(targetPath))).value;
    const fixture = await tufFixture({
      targetPath,
      pathHashPrefixes: [hash.slice(0, 4)],
    });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        fixture.files,
        targetPath,
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).resolves.toMatchObject({ role: 'tools' });

    const missed = await tufFixture({
      targetPath,
      pathHashPrefixes: [hash.slice(0, 3) === 'ffff' ? '0000' : 'ffff'],
    });
    await expect(
      verifyTufTarget(
        missed.trusted,
        missed.files,
        targetPath,
        missed.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'target' });
  });
});

describe('TUF', () => {
  test('persists rollback state for every verified delegated role', async () => {
    const fixture = await tufFixture();
    const decode = (bytes: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(bytes)) as SignedMetadata<
        TargetsMetadata | SnapshotMetadata
      >;
    const originalTargets = decode(fixture.files.targets)
      .signed as TargetsMetadata;
    const originalSnapshot = decode(fixture.files.snapshot)
      .signed as SnapshotMetadata;
    const seenRole = {
      name: 'seen',
      keyids: ['root'],
      threshold: 1,
      paths: ['tools/*'],
      terminating: false,
    };
    const targets = await signed<TargetsMetadata>({
      ...originalTargets,
      delegations: {
        ...originalTargets.delegations!,
        roles: [seenRole, ...originalTargets.delegations!.roles],
      },
    });
    const targetsFile = await file(targets, 1);
    const delegated = async (version: number) =>
      file(
        await signed<TargetsMetadata>({
          _type: 'targets',
          spec_version: '1.0.31',
          version,
          expires: '2027-01-01T00:00:00Z',
          targets: {},
        }),
        version,
      );
    const newer = await delegated(5);
    const snapshot = async (
      version: number,
      seen: Awaited<ReturnType<typeof delegated>>,
    ) => {
      const metadata = await signed<SnapshotMetadata>({
        _type: 'snapshot',
        spec_version: '1.0.31',
        version,
        expires: '2027-01-01T00:00:00Z',
        meta: {
          'targets.json': targetsFile.meta,
          'seen.json': seen.meta,
          'tools.json': originalSnapshot.meta['tools.json']!,
        },
      });
      return file(metadata, version);
    };
    const timestamp = async (
      version: number,
      snapshotFile: Awaited<ReturnType<typeof snapshot>>,
    ) =>
      encode(
        await signed<TimestampMetadata>({
          _type: 'timestamp',
          spec_version: '1.0.31',
          version,
          expires: '2027-01-01T00:00:00Z',
          meta: { 'snapshot.json': snapshotFile.meta },
        }),
      );
    const firstSnapshot = await snapshot(1, newer);
    const first = await verifyTufTarget(
      fixture.trusted,
      {
        ...fixture.files,
        timestamp: await timestamp(1, firstSnapshot),
        snapshot: firstSnapshot.bytes,
        targets: targetsFile.bytes,
        delegated: { ...fixture.files.delegated, seen: newer.bytes },
        delegatedFileNames: {
          ...fixture.files.delegatedFileNames,
          seen: '5.seen.json',
        },
      },
      fixture.targetPath,
      fixture.targetBytes,
      '2026-01-01T00:00:00Z',
    );
    expect(first.state.metadataVersions.seen).toBe(5);

    const older = await delegated(1);
    const secondSnapshot = await snapshot(2, older);
    await expect(
      verifyTufTarget(
        first.state,
        {
          ...fixture.files,
          timestamp: await timestamp(2, secondSnapshot),
          snapshot: secondSnapshot.bytes,
          targets: targetsFile.bytes,
          delegated: { ...fixture.files.delegated, seen: older.bytes },
          delegatedFileNames: {
            ...fixture.files.delegatedFileNames,
            seen: '1.seen.json',
          },
        },
        fixture.targetPath,
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'rollback' });
  });

  test('verifies delegated consistent snapshots and rejects attacks', async () => {
    const fixture = await tufFixture();
    await expect(
      verifyTufTarget(
        fixture.trusted,
        fixture.files,
        'tools/demo.bin',
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).resolves.toMatchObject({ role: 'tools' });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        { ...fixture.files, targetsFileName: 'targets.json' },
        'tools/demo.bin',
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'mix-match' });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        {
          ...fixture.files,
          timestamp: new TextEncoder().encode(
            '{"signed":{},"signed":{},"signatures":[]}',
          ),
        },
        'tools/demo.bin',
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'mix-match' });
    await expect(
      verifyTufTarget(
        { ...fixture.trusted, timestampVersion: 2 },
        fixture.files,
        'tools/demo.bin',
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'rollback' });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        fixture.files,
        'tools/demo.bin',
        fixture.targetBytes,
        '2029-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'expired' });
    await expect(
      verifyTufTarget(
        fixture.trusted,
        fixture.files,
        'tools/demo.bin',
        new Uint8Array([0]),
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'target' });
    const corrupt = Uint8Array.from(fixture.files.snapshot);
    corrupt[10] ^= 1;
    await expect(
      verifyTufTarget(
        fixture.trusted,
        { ...fixture.files, snapshot: corrupt },
        'tools/demo.bin',
        fixture.targetBytes,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toMatchObject({ code: 'mix-match' });
  });

  test('requires old and new root authorization on rotation', async () => {
    const fixture = await tufFixture();
    const nextValue: RootMetadata = {
      ...fixture.trusted.root.signed,
      version: 2,
      keys: { leaf: key(keys.leaf.x) },
      roles: Object.fromEntries(
        ['root', 'timestamp', 'snapshot', 'targets'].map((role) => [
          role,
          { keyids: ['leaf'], threshold: 1 },
        ]),
      ),
    };
    const next = await signed(nextValue, [
      await signer('root'),
      await signer('leaf'),
    ]);
    await expect(
      verifyRootRotation(fixture.trusted.root, next),
    ).resolves.toBeUndefined();
    await expect(
      verifyRootRotation(
        fixture.trusted.root,
        await signed(nextValue, [await signer('leaf')]),
      ),
    ).rejects.toMatchObject({ code: 'signature' });
  });
});

test('Ed25519 canonical signing is maintained WebCrypto, not invented crypto', async () => {
  const value = { z: 1, a: 'signed' };
  const root = await signer('root');
  const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
  await expect(
    verifyCanonical(value, await root.sign(canonicalBytes(value)), verifier),
  ).resolves.toBe(true);
});

test('verifies an offline Sigstore bundle including identity and transparency evidence', async () => {
  const artifact = new TextEncoder().encode('sigstore fixture');
  const artifactDigest = await sha256(artifact);
  const leafPayload = canonicalBytes(artifactDigest);
  const leaf = new Uint8Array(leafPayload.length + 1);
  leaf.set(leafPayload, 1);
  const leafDigest = await sha256(leaf);
  const certificate = {
    publicKey: keys.leaf.x,
    issuer: 'https://issuer.example',
    identity: 'release@example.test',
    notBefore: '2025-01-01T00:00:00Z',
    notAfter: '2027-01-01T00:00:00Z',
    signature: '',
  };
  certificate.signature = await (
    await signer('root')
  ).sign(
    canonicalBytes({
      publicKey: certificate.publicKey,
      issuer: certificate.issuer,
      identity: certificate.identity,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
    }),
  );
  const entry = {
    logId: 'fixture-log',
    bodyDigest: artifactDigest,
    integratedTime: '2026-01-01T00:00:00Z',
    inclusionProof: {
      rootHash: leafDigest.value,
      logIndex: 0,
      treeSize: 1,
      hashes: [] as string[],
    },
    checkpointSignature: '',
  };
  entry.checkpointSignature = await (
    await signer('log')
  ).sign(
    canonicalBytes({
      logId: entry.logId,
      bodyDigest: entry.bodyDigest,
      integratedTime: entry.integratedTime,
      inclusionProof: entry.inclusionProof,
    }),
  );
  const bundle: OfflineSigstoreBundle = {
    mediaType: 'application/vnd.openpacker.offline-sigstore-fixture.v1+json',
    messageSignature: {
      messageDigest: artifactDigest,
      signature: await (
        await signer('leaf')
      ).sign(new TextEncoder().encode(`sha256:${artifactDigest.value}`)),
    },
    verificationMaterial: { certificate, tlogEntry: entry },
  };
  const trustRoot = {
    certificateAuthority: { keyId: 'root', publicKey: keys.root.x },
    transparencyLog: { logId: 'fixture-log', publicKey: keys.log.x },
  };
  await expect(
    verifyOfflineSigstoreBundle(
      bundle,
      artifact,
      trustRoot,
      { issuer: certificate.issuer, identity: certificate.identity },
      '2026-01-01T00:00:00Z',
    ),
  ).resolves.toBeUndefined();
  await expect(
    verifyOfflineSigstoreBundle(
      bundle,
      artifact,
      trustRoot,
      { issuer: certificate.issuer, identity: 'attacker@example.test' },
      '2026-01-01T00:00:00Z',
    ),
  ).rejects.toThrow('identity');
  const tampered = structuredClone(bundle);
  tampered.verificationMaterial.tlogEntry.inclusionProof.rootHash = '0'.repeat(
    64,
  );
  await expect(
    verifyOfflineSigstoreBundle(
      tampered,
      artifact,
      trustRoot,
      { issuer: certificate.issuer, identity: certificate.identity },
      '2026-01-01T00:00:00Z',
    ),
  ).rejects.toThrow('inclusion');
  const invalidTime = structuredClone(bundle);
  invalidTime.verificationMaterial.certificate.notBefore = 'not-a-date';
  invalidTime.verificationMaterial.certificate.signature = await (
    await signer('root')
  ).sign(
    canonicalBytes({
      publicKey: invalidTime.verificationMaterial.certificate.publicKey,
      issuer: invalidTime.verificationMaterial.certificate.issuer,
      identity: invalidTime.verificationMaterial.certificate.identity,
      notBefore: invalidTime.verificationMaterial.certificate.notBefore,
      notAfter: invalidTime.verificationMaterial.certificate.notAfter,
    }),
  );
  await expect(
    verifyOfflineSigstoreBundle(
      invalidTime,
      artifact,
      trustRoot,
      { issuer: certificate.issuer, identity: certificate.identity },
      '2026-01-01T00:00:00Z',
    ),
  ).rejects.toThrow('time');
});

test('binds SLSA subjects and extracts CycloneDX license evidence', async () => {
  const subject = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };
  const slsa = {
    _type: 'https://in-toto.io/Statement/v1' as const,
    subject: [{ name: 'artifact', digest: { sha256: subject.value } }],
    predicateType: 'https://slsa.dev/provenance/v1' as const,
    predicate: {
      buildDefinition: {
        buildType: 'https://example.test/build',
        externalParameters: {},
        internalParameters: {},
        resolvedDependencies: [
          {
            uri: 'https://example.test/src',
            digest: { sha256: 'b'.repeat(64) },
          },
        ],
      },
      runDetails: { builder: { id: 'https://example.test/builder' } },
    },
  };
  expect(verifySlsaProvenance(slsa, subject).builderId).toContain('builder');
  expect(() =>
    verifySlsaProvenance(slsa, { ...subject, value: 'c'.repeat(64) }),
  ).toThrow('subject mismatch');
  const evidence = extractCycloneDxEvidence({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [
      {
        purl: 'pkg:npm/demo@1.0.0',
        licenses: [{ expression: 'MIT' }],
        hashes: [{ alg: 'SHA-256', content: subject.value }],
      },
    ],
    dependencies: [],
  });
  expect(evidence.licenses).toEqual([
    { status: 'declared', expression: 'MIT' },
  ]);
  expect(() =>
    extractCycloneDxEvidence({
      bomFormat: 'CycloneDX',
      specVersion: '1.9',
      components: [],
    }),
  ).toThrow('Unsupported');
  expect(
    cycloneDxEvidenceStatus({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      components: [],
    }),
  ).toBe('invalid');
  expect(
    cycloneDxEvidenceStatus({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      components: [
        {
          purl: 'pkg:npm/demo@1.0.0',
          hashes: [{ alg: 'SHA-256', content: subject.value }],
        },
      ],
    }),
  ).toBe('valid');
});
