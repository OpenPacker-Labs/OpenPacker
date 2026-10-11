import { describe, expect, it } from 'vitest';
import { canonicalize } from '@openpacker/canonical';
import {
  emptyLockfile,
  parseLockfile,
  parseManifest,
  priorAttestationsFromLock,
  registryOptionsForEcosystem,
  reproducibleLockForm,
  serializeLockfile,
  serializeManifest,
  type LockAttestation,
  type LockPackage,
  type OpmLockfile,
  type OpmManifest,
} from '../src/index.js';

const PROJECT = 'github.com/jdx/hk';

const MANIFEST = `
[project]
name = "demo"
ecosystems = ["packslip"]

[packages.hk]
purl = "pkg:packslip/github.com/jdx/hk"
version = "2.5.0"

[adapters.packslip]
approvals = ["0123456789abcdef"]
allow_incompatible_host = true

[adapters.packslip.trust."${PROJECT}"]
public_key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
allow_unlogged = true

[adapters.packslip.trust."mise.jdx.dev"]
identity_prefix = "jdx/mise/.github/workflows/release.yml"
issuer = "https://token.actions.githubusercontent.com"
`;

describe('adapter settings in opm.toml', () => {
  it('reads each ecosystem’s settings as plain JSON, untouched', () => {
    const manifest = parseManifest(MANIFEST);
    expect(manifest.adapterSettings).toEqual({
      packslip: {
        approvals: ['0123456789abcdef'],
        allow_incompatible_host: true,
        trust: {
          [PROJECT]: {
            public_key:
              'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
            allow_unlogged: true,
          },
          'mise.jdx.dev': {
            identity_prefix: 'jdx/mise/.github/workflows/release.yml',
            issuer: 'https://token.actions.githubusercontent.com',
          },
        },
      },
    });
  });

  it('writes what it read, and reading that again changes nothing', () => {
    const once = serializeManifest(parseManifest(MANIFEST));
    const twice = serializeManifest(parseManifest(once));
    expect(twice).toBe(once);
    expect(once).toContain(`[adapters.packslip.trust."${PROJECT}"]`);
  });

  it('is part of what the lock is stale against', () => {
    const before = serializeManifest(parseManifest(MANIFEST));
    const after = serializeManifest(
      parseManifest(
        MANIFEST.replace('allow_unlogged = true', 'allow_unlogged = false'),
      ),
    );
    expect(after).not.toBe(before);
  });

  it('leaves a manifest without settings exactly as it was', () => {
    const plain = parseManifest(
      '[project]\nname = "x"\necosystems = ["npm"]\n',
    );
    expect(plain.adapterSettings).toBeUndefined();
    expect(serializeManifest(plain)).not.toContain('adapters');
  });

  it.each([
    ['an unnamed ecosystem', '[adapters.]\nk = 1'],
    ['an ecosystem that is not a purl type', '[adapters.Pack_Slip]\nk = 1'],
    ['a table with a bare key', '[adapters.packslip.trust.x]\nk = 1'],
    ['a key that is not a string', '[adapters.packslip.trust.5]\nk = 1'],
    ['an empty entry key', '[adapters.packslip.trust.""]\nk = 1'],
    ['a table name with a dot', '[adapters.packslip.a.b."x"]\nk = 1'],
    ['a setting given twice', '[adapters.packslip]\nk = 1\nk = 2'],
  ])('refuses %s', (_label, section) => {
    expect(() =>
      parseManifest(`[project]\nname = "x"\necosystems = []\n\n${section}\n`),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('refuses to write a setting the file format cannot hold', () => {
    const manifest: OpmManifest = {
      ...parseManifest('[project]\nname = "x"\necosystems = []\n'),
      adapterSettings: {
        packslip: { nested: { deeper: { too: { far: 1 } } } },
      },
    };
    expect(() => serializeManifest(manifest)).toThrow(
      expect.objectContaining({ code: 'INVALID_MANIFEST' }),
    );
    expect(() =>
      serializeManifest({
        ...manifest,
        adapterSettings: { packslip: { list: [1, 2] } },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });
});

const ATTESTATION: LockAttestation = {
  kind: 'packslip',
  signerIdentity: 'jdx/mise/.github/workflows/release.yml',
  issuer: 'https://token.actions.githubusercontent.com',
  signedAt: '2026-09-01T12:00:00.000Z',
  signedAtVerified: true,
  evidence: ['sigstore', 'sigstore-transparency'],
  record: { signer: { scheme: 'sigstore-oidc' }, sequence: 42 },
};

function lockWith(attestation: unknown): string {
  const lock = emptyLockfile();
  const pkg: LockPackage = {
    alias: 'hk',
    purl: `pkg:packslip/${PROJECT}@2.5.0`,
    version: '2.5.0',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 10,
    format: 'tar+gzip',
    mediaType: 'application/gzip',
    source: 'https://github.com/jdx/hk/releases/download/v2.5.0/hk.tar.gz',
    storeKey: 'k',
    bins: [{ name: 'hk', path: 'hk/bin/hk', interpreter: 'native' }],
    reason: 'direct',
    ecosystem: 'packslip',
  };
  lock.packages.hk = pkg;
  const text = JSON.parse(serializeLockfile(lock));
  if (attestation !== undefined) text.packages.hk.attestation = attestation;
  return JSON.stringify(text);
}

describe('signature evidence in the lock', () => {
  it('survives a write and a read', () => {
    const lock = parseLockfile(lockWith(ATTESTATION));
    expect(lock.packages.hk?.attestation).toEqual(ATTESTATION);
    const again = parseLockfile(serializeLockfile(lock));
    expect(again.packages.hk?.attestation).toEqual(ATTESTATION);
  });

  it('is optional: most packages have none', () => {
    expect(parseLockfile(lockWith(undefined)).packages.hk?.attestation).toBe(
      undefined,
    );
  });

  it.each([
    ['not an object', 'signed'],
    ['a list', []],
    ['a field nobody defined', { ...ATTESTATION, verified: true }],
    ['no kind', { ...ATTESTATION, kind: undefined }],
    ['an empty signer', { ...ATTESTATION, signerIdentity: '' }],
    [
      'a signing time that is not a time',
      { ...ATTESTATION, signedAt: 'later' },
    ],
    [
      'a verified flag that is not a boolean',
      { ...ATTESTATION, signedAtVerified: 'yes' },
    ],
    ['evidence that is not a list', { ...ATTESTATION, evidence: 'sigstore' }],
    [
      'evidence with a non-string',
      { ...ATTESTATION, evidence: ['sigstore', 3] },
    ],
    ['an empty issuer', { ...ATTESTATION, issuer: '' }],
    ['a record that is not an object', { ...ATTESTATION, record: 'x' }],
    ['a record that is a list', { ...ATTESTATION, record: [] }],
  ])('refuses %s', (_label, attestation) => {
    expect(() => parseLockfile(lockWith(attestation))).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCK' }),
    );
  });
});

function lockedWith(
  attestation: LockAttestation | undefined,
  over: Partial<LockPackage> = {},
  alias = 'hk',
): OpmLockfile {
  const lock = emptyLockfile();
  lock.packages[alias] = {
    alias,
    purl: `pkg:packslip/${PROJECT}@2.5.0`,
    version: '2.5.0',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 10,
    format: 'tar+gzip',
    mediaType: 'application/gzip',
    source: 'https://github.com/jdx/hk/releases/download/v2.5.0/hk.tar.gz',
    storeKey: 'k',
    bins: [],
    reason: 'direct',
    ecosystem: 'packslip',
    ...(attestation !== undefined && { attestation }),
    ...over,
  };
  return lock;
}

const withList = (sequence: number, advancing = ['list']): LockAttestation => ({
  ...ATTESTATION,
  record: { ...ATTESTATION.record, list: { sequence } },
  advancing,
});

describe('what a frozen install requires a fresh resolution to reproduce', () => {
  const same = (left: OpmLockfile, right: OpmLockfile) =>
    canonicalize(reproducibleLockForm(left, right)) ===
    canonicalize(reproducibleLockForm(right, right));

  it('lets a signed list move forward without the release changing', () => {
    expect(same(lockedWith(withList(5)), lockedWith(withList(9)))).toBe(true);
  });

  it('lets a list appear or disappear', () => {
    expect(same(lockedWith(ATTESTATION), lockedWith(withList(9)))).toBe(true);
    expect(same(lockedWith(withList(9)), lockedWith(ATTESTATION))).toBe(false);
  });

  it('still notices the release itself changing', () => {
    const other: LockAttestation = {
      ...withList(9),
      record: { ...withList(9).record, bundle_digest: 'sha256:other' },
    };
    expect(same(lockedWith(withList(5)), lockedWith(other))).toBe(false);
    expect(
      same(
        lockedWith(withList(5)),
        lockedWith({ ...withList(9), signerIdentity: 'someone-else' }),
      ),
    ).toBe(false);
  });

  it('takes which keys advance from the fresh resolution, never from the lock', () => {
    // An edited lock cannot excuse its own differences by declaring them
    // advancing; only the resolution opm just performed can.
    const fresh = lockedWith(withList(9, ['list']));
    const tampered = lockedWith({
      ...withList(5),
      advancing: ['list', 'signer'],
      record: { ...withList(5).record, signer: { scheme: 'sigstore-key' } },
    });
    expect(same(tampered, fresh)).toBe(false);
  });

  it('leaves a package without an attestation exactly as it is', () => {
    expect(same(lockedWith(undefined), lockedWith(undefined))).toBe(true);
    expect(same(lockedWith(undefined), lockedWith(ATTESTATION))).toBe(false);
  });
});

describe('what the lock tells the adapter about the last accepted signer', () => {
  it('is keyed by the versionless PURL and covers only that ecosystem', () => {
    const lock = lockedWith(ATTESTATION);
    const { attestation: _none, ...bare } = lock.packages.hk!;
    lock.packages.other = {
      ...bare,
      alias: 'other',
      purl: 'pkg:npm/other@1.0.0',
      ecosystem: 'npm',
    };
    expect(priorAttestationsFromLock(lock, 'packslip')).toEqual({
      [`pkg:packslip/${PROJECT}`]: ATTESTATION.record,
    });
    expect(priorAttestationsFromLock(lock, 'npm')).toBeUndefined();
  });

  it('is absent without a lock or without evidence', () => {
    expect(priorAttestationsFromLock(undefined, 'packslip')).toBeUndefined();
    expect(
      priorAttestationsFromLock(lockedWith(undefined), 'packslip'),
    ).toBeUndefined();
  });

  it('keeps the most recently signed record when a package is locked twice', () => {
    const older: LockAttestation = {
      ...ATTESTATION,
      signedAt: '2026-01-01T00:00:00.000Z',
      record: { generation: 'old' },
    };
    const newer: LockAttestation = {
      ...ATTESTATION,
      signedAt: '2026-06-01T00:00:00.000Z',
      record: { generation: 'new' },
    };
    const lock = lockedWith(older, {}, 'a');
    lock.packages.b = {
      ...lockedWith(newer, {}, 'b').packages.b!,
      purl: `pkg:packslip/${PROJECT}@2.6.0`,
    };
    expect(priorAttestationsFromLock(lock, 'packslip')).toEqual({
      [`pkg:packslip/${PROJECT}`]: { generation: 'new' },
    });
  });
});

describe('what reaches an adapter from the project', () => {
  const manifest = parseManifest(MANIFEST);

  it('takes settings from the committed manifest', () => {
    expect(registryOptionsForEcosystem('packslip', manifest).settings).toEqual(
      manifest.adapterSettings?.packslip,
    );
  });

  it('takes what the lock remembered, alongside', () => {
    const options = registryOptionsForEcosystem(
      'packslip',
      manifest,
      {},
      lockedWith(ATTESTATION),
    );
    expect(options.priorAttestations).toEqual({
      [`pkg:packslip/${PROJECT}`]: ATTESTATION.record,
    });
  });

  it('lets a caller replace settings wholesale, but not the other ecosystems', () => {
    expect(
      registryOptionsForEcosystem('packslip', manifest, {
        settings: { approvals: [] },
      }).settings,
    ).toEqual({ approvals: [] });
    expect(
      registryOptionsForEcosystem('npm', manifest).settings,
    ).toBeUndefined();
  });

  it('adds nothing when the project says nothing', () => {
    const plain = parseManifest(
      '[project]\nname = "x"\necosystems = ["npm"]\n',
    );
    const options = registryOptionsForEcosystem('npm', plain);
    expect(options.settings).toBeUndefined();
    expect(options.priorAttestations).toBeUndefined();
  });
});
