import {
  canonicalBytes,
  parseCanonicalJson,
  sha256,
} from '@openpacker/canonical';
import { minimatch } from 'minimatch';
import type { Digest, JsonValue } from '@openpacker/contracts';
import { Ed25519Verifier, type Verifier } from './signatures.js';

export interface TufSignature {
  keyid: string;
  sig: string;
}
export interface SignedMetadata<T extends TufSigned = TufSigned> {
  signed: T;
  signatures: TufSignature[];
}
export interface TufSigned {
  _type: string;
  spec_version: '1.0.31';
  version: number;
  expires: string;
}
export interface TufKey {
  keytype: 'ed25519';
  scheme: 'ed25519';
  keyval: { public: string };
}
export interface TufRole {
  keyids: string[];
  threshold: number;
}
export interface RootMetadata extends TufSigned {
  _type: 'root';
  consistent_snapshot: boolean;
  keys: Record<string, TufKey>;
  roles: Record<string, TufRole>;
}
export interface MetaFile {
  version: number;
  length: number;
  hashes: { sha256: string };
}
export interface TimestampMetadata extends TufSigned {
  _type: 'timestamp';
  meta: { 'snapshot.json': MetaFile };
}
export interface SnapshotMetadata extends TufSigned {
  _type: 'snapshot';
  meta: Record<string, MetaFile>;
}
export interface TargetFile {
  length: number;
  hashes: { sha256: string };
  custom?: JsonValue;
}
export interface DelegatedRole extends TufRole {
  name: string;
  /** Path patterns this role may sign for. Exclusive with pathHashPrefixes. */
  paths?: string[];
  /** Hex prefixes of sha256(targetPath). Exclusive with paths. */
  path_hash_prefixes?: string[];
  terminating: boolean;
}
export interface TargetsMetadata extends TufSigned {
  _type: 'targets';
  targets: Record<string, TargetFile>;
  delegations?: { keys: Record<string, TufKey>; roles: DelegatedRole[] };
}
export interface TrustedTufState {
  root: SignedMetadata<RootMetadata>;
  timestampVersion: number;
  snapshotVersion: number;
  metadataVersions: Record<string, number>;
  timestampDigest?: Digest;
  snapshotDigest?: Digest;
  metadataDigests?: Record<string, Digest>;
}

export class TufVerificationError extends Error {
  constructor(
    readonly code:
      | 'signature'
      | 'expired'
      | 'rollback'
      | 'mix-match'
      | 'target'
      | 'delegation'
      | 'root-rotation',
    message: string,
  ) {
    super(message);
    this.name = 'TufVerificationError';
  }
}

async function digest(bytes: Uint8Array): Promise<Digest> {
  return sha256(bytes);
}
/**
 * Whether a delegated role is authorised for a target path.
 *
 * TUF path patterns are matched per path segment, with an equal segment count
 * required (tuf-js `isTargetInPathPattern`, python-tuf `is_delegated_path`).
 * That is the whole point of the rule: `tools/*` delegates the `tools`
 * directory, not everything beneath it, so a role scoped to `tools/*` must not
 * gain authority over `tools/vendor/backdoor.bin`. Matching is delegated to
 * minimatch — the same matcher the reference client uses — rather than
 * re-derived here.
 *
 * `paths` and `path_hash_prefixes` are mutually exclusive; a role that
 * declares neither is authorised for nothing.
 */
async function isDelegatedPath(
  role: DelegatedRole,
  targetPath: string,
): Promise<boolean> {
  if (role.paths) {
    const targetParts = targetPath.split('/');
    return role.paths.some((pattern) => {
      const patternParts = pattern.split('/');
      if (patternParts.length !== targetParts.length) return false;
      return patternParts.every((part, index) =>
        minimatch(targetParts[index]!, part, { dot: true }),
      );
    });
  }
  if (role.path_hash_prefixes) {
    const hash = (await digest(new TextEncoder().encode(targetPath))).value;
    return role.path_hash_prefixes.some((prefix) => hash.startsWith(prefix));
  }
  return false;
}

async function verifyMetaFile(
  file: MetaFile,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  const actual = await digest(bytes);
  if (bytes.length !== file.length || actual.value !== file.hashes.sha256)
    throw new TufVerificationError(
      'mix-match',
      `${label} does not match its signed length and digest`,
    );
}

async function keyVerifier(keyId: string, key: TufKey): Promise<Verifier> {
  return Ed25519Verifier.fromJwk(keyId, {
    kty: 'OKP',
    crv: 'Ed25519',
    x: key.keyval.public,
    ext: true,
  });
}

async function threshold<T extends TufSigned>(
  metadata: SignedMetadata<T>,
  role: TufRole,
  keys: Record<string, TufKey>,
): Promise<void> {
  if (
    !Number.isInteger(role.threshold) ||
    role.threshold < 1 ||
    role.threshold > role.keyids.length
  )
    throw new TufVerificationError(
      'signature',
      'Invalid TUF signature threshold',
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const payload = canonicalBytes(
    JSON.parse(JSON.stringify(metadata.signed)) as JsonValue,
  );
  const valid = new Set<string>();
  for (const signature of metadata.signatures) {
    if (valid.has(signature.keyid) || !role.keyids.includes(signature.keyid))
      continue;
    const key = keys[signature.keyid];
    if (
      key &&
      (await (
        await keyVerifier(signature.keyid, key)
      ).verify(payload, signature.sig))
    )
      valid.add(signature.keyid);
  }
  if (valid.size < role.threshold)
    throw new TufVerificationError(
      'signature',
      `TUF ${metadata.signed._type} threshold not met`,
    );
}

function role(root: RootMetadata, name: string): TufRole {
  const value = root.roles[name];
  if (!value)
    throw new TufVerificationError('signature', `TUF root omits ${name} role`);
  return value;
}

function fresh(metadata: TufSigned, now: string): void {
  const expires = Date.parse(metadata.expires);
  const evaluation = Date.parse(now);
  if (
    !Number.isFinite(expires) ||
    !Number.isFinite(evaluation) ||
    expires <= evaluation
  )
    throw new TufVerificationError(
      'expired',
      `${metadata._type} metadata is expired`,
    );
}

function parse<T extends TufSigned>(bytes: Uint8Array): SignedMetadata<T> {
  let value: SignedMetadata<T>;
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    value = parseCanonicalJson(
      new TextDecoder().decode(bytes),
    ) as unknown as SignedMetadata<T>;
  } catch {
    throw new TufVerificationError('mix-match', 'Malformed TUF metadata');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !value.signed ||
    !Array.isArray(value.signatures)
  )
    throw new TufVerificationError('mix-match', 'Malformed TUF metadata');
  return value;
}

export async function verifyRootRotation(
  current: SignedMetadata<RootMetadata>,
  next: SignedMetadata<RootMetadata>,
  evaluationTime?: string,
): Promise<void> {
  if (
    current.signed._type !== 'root' ||
    next.signed._type !== 'root' ||
    current.signed.spec_version !== '1.0.31' ||
    next.signed.spec_version !== '1.0.31'
  )
    throw new TufVerificationError('root-rotation', 'Invalid root metadata');
  if (next.signed.version !== current.signed.version + 1)
    throw new TufVerificationError(
      'root-rotation',
      'Root versions must advance exactly once',
    );
  await threshold(next, role(current.signed, 'root'), current.signed.keys);
  await threshold(next, role(next.signed, 'root'), next.signed.keys);
  if (evaluationTime) fresh(next.signed, evaluationTime);
}

export interface TufRepositoryFiles {
  timestamp: Uint8Array;
  snapshot: Uint8Array;
  targets: Uint8Array;
  targetsFileName?: string;
  delegated?: Record<string, Uint8Array>;
  delegatedFileNames?: Record<string, string>;
}
export interface TufVerification {
  state: TrustedTufState;
  target: TargetFile;
  role: string;
}

export async function verifyTufTarget(
  trusted: TrustedTufState,
  files: TufRepositoryFiles,
  targetPath: string,
  targetBytes: Uint8Array,
  evaluationTime: string,
): Promise<TufVerification> {
  const root = trusted.root.signed;
  if (
    root._type !== 'root' ||
    root.spec_version !== '1.0.31' ||
    !Number.isInteger(root.version) ||
    root.version < 1
  )
    throw new TufVerificationError(
      'signature',
      'Invalid trusted TUF root metadata',
    );
  await threshold(trusted.root, role(root, 'root'), root.keys);
  fresh(root, evaluationTime);
  const timestamp = parse<TimestampMetadata>(files.timestamp);
  const timestampDigest = await digest(files.timestamp);
  if (
    timestamp.signed._type !== 'timestamp' ||
    timestamp.signed.spec_version !== '1.0.31'
  )
    throw new TufVerificationError(
      'mix-match',
      'Expected TUF timestamp metadata',
    );
  await threshold(timestamp, role(root, 'timestamp'), root.keys);
  fresh(timestamp.signed, evaluationTime);
  if (timestamp.signed.version < trusted.timestampVersion)
    throw new TufVerificationError('rollback', 'Timestamp rollback detected');
  if (
    timestamp.signed.version === trusted.timestampVersion &&
    trusted.timestampDigest &&
    trusted.timestampDigest.value !== timestampDigest.value
  )
    throw new TufVerificationError(
      'mix-match',
      'Timestamp changed without a version increase',
    );
  const snapshotFile = timestamp.signed.meta['snapshot.json'];
  if (!snapshotFile)
    throw new TufVerificationError(
      'mix-match',
      'Timestamp omits snapshot metadata',
    );
  await verifyMetaFile(snapshotFile, files.snapshot, 'snapshot.json');
  const snapshotDigest = await digest(files.snapshot);
  const snapshot = parse<SnapshotMetadata>(files.snapshot);
  if (
    snapshot.signed._type !== 'snapshot' ||
    snapshot.signed.spec_version !== '1.0.31'
  )
    throw new TufVerificationError(
      'mix-match',
      'Expected TUF snapshot metadata',
    );
  await threshold(snapshot, role(root, 'snapshot'), root.keys);
  fresh(snapshot.signed, evaluationTime);
  if (
    snapshot.signed.version !== snapshotFile.version ||
    snapshot.signed.version < trusted.snapshotVersion
  )
    throw new TufVerificationError('rollback', 'Snapshot rollback detected');
  if (
    snapshot.signed.version === trusted.snapshotVersion &&
    trusted.snapshotDigest &&
    trusted.snapshotDigest.value !== snapshotDigest.value
  )
    throw new TufVerificationError(
      'mix-match',
      'Snapshot changed without a version increase',
    );
  const targetsName = 'targets.json';
  const targetsFile = snapshot.signed.meta[targetsName];
  if (!targetsFile)
    throw new TufVerificationError(
      'mix-match',
      'Snapshot omits targets metadata',
    );
  if (
    root.consistent_snapshot &&
    files.targetsFileName !== `${targetsFile.version}.targets.json`
  )
    throw new TufVerificationError(
      'mix-match',
      'Consistent snapshot targets filename is not versioned',
    );
  await verifyMetaFile(targetsFile, files.targets, targetsName);
  const targets = parse<TargetsMetadata>(files.targets);
  const targetsDigest = await digest(files.targets);
  if (
    targets.signed._type !== 'targets' ||
    targets.signed.spec_version !== '1.0.31'
  )
    throw new TufVerificationError(
      'mix-match',
      'Expected TUF targets metadata',
    );
  await threshold(targets, role(root, 'targets'), root.keys);
  fresh(targets.signed, evaluationTime);
  if (
    targets.signed.version !== targetsFile.version ||
    targets.signed.version < (trusted.metadataVersions.targets ?? 0)
  )
    throw new TufVerificationError('rollback', 'Targets rollback detected');
  if (
    targets.signed.version === (trusted.metadataVersions.targets ?? 0) &&
    trusted.metadataDigests?.targets &&
    trusted.metadataDigests.targets.value !== targetsDigest.value
  )
    throw new TufVerificationError(
      'mix-match',
      'Targets changed without a version increase',
    );

  let target = targets.signed.targets[targetPath];
  let roleName = 'targets';
  const delegatedVersions: Record<string, number> = {};
  const delegatedDigests: Record<string, Digest> = {};
  if (!target && targets.signed.delegations) {
    for (const delegatedRole of targets.signed.delegations.roles) {
      if (!(await isDelegatedPath(delegatedRole, targetPath))) continue;
      const name = `${delegatedRole.name}.json`;
      const snapshotDelegated = snapshot.signed.meta[name];
      const delegatedBytes = files.delegated?.[delegatedRole.name];
      if (!snapshotDelegated || !delegatedBytes)
        throw new TufVerificationError(
          'delegation',
          `Missing delegated metadata ${delegatedRole.name}`,
        );
      if (
        root.consistent_snapshot &&
        files.delegatedFileNames?.[delegatedRole.name] !==
          `${snapshotDelegated.version}.${name}`
      )
        throw new TufVerificationError(
          'mix-match',
          'Consistent snapshot delegated filename is not versioned',
        );
      await verifyMetaFile(snapshotDelegated, delegatedBytes, name);
      const delegated = parse<TargetsMetadata>(delegatedBytes);
      if (
        delegated.signed._type !== 'targets' ||
        delegated.signed.spec_version !== '1.0.31'
      )
        throw new TufVerificationError(
          'delegation',
          'Delegated metadata is not targets metadata',
        );
      const delegatedDigest = await digest(delegatedBytes);
      await threshold(
        delegated,
        delegatedRole,
        targets.signed.delegations.keys,
      );
      fresh(delegated.signed, evaluationTime);
      if (
        delegated.signed.version !== snapshotDelegated.version ||
        delegated.signed.version <
          (trusted.metadataVersions[delegatedRole.name] ?? 0)
      )
        throw new TufVerificationError(
          'rollback',
          'Delegated targets rollback detected',
        );
      if (
        delegated.signed.version ===
          (trusted.metadataVersions[delegatedRole.name] ?? 0) &&
        trusted.metadataDigests?.[delegatedRole.name] &&
        trusted.metadataDigests[delegatedRole.name]!.value !==
          delegatedDigest.value
      )
        throw new TufVerificationError(
          'mix-match',
          'Delegated metadata changed without a version increase',
        );
      delegatedVersions[delegatedRole.name] = delegated.signed.version;
      delegatedDigests[delegatedRole.name] = delegatedDigest;
      target = delegated.signed.targets[targetPath];
      if (target) {
        roleName = delegatedRole.name;
        break;
      }
      if (delegatedRole.terminating) break;
    }
  }
  if (!target)
    throw new TufVerificationError(
      'target',
      `Target is not authorized: ${targetPath}`,
    );
  const actual = await digest(targetBytes);
  if (
    target.length !== targetBytes.length ||
    target.hashes.sha256 !== actual.value
  )
    throw new TufVerificationError(
      'target',
      'Target bytes do not match signed length and digest',
    );
  return {
    target,
    role: roleName,
    state: {
      root: trusted.root,
      timestampVersion: timestamp.signed.version,
      snapshotVersion: snapshot.signed.version,
      metadataVersions: {
        ...trusted.metadataVersions,
        targets: targets.signed.version,
        ...delegatedVersions,
      },
      timestampDigest,
      snapshotDigest,
      metadataDigests: {
        ...trusted.metadataDigests,
        targets: targetsDigest,
        ...delegatedDigests,
      },
    },
  };
}
