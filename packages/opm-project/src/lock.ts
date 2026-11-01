import { parseCanonicalJson, plainLine } from '@openpacker/canonical';
import { isSourceKind, isTrustTier } from '@openpacker/policy';
import { canonicalLockPurl } from './lock-purl.js';
import { readStableFile, writeStableFile } from './paths.js';
import type {
  BinDeclaration,
  LockAttestation,
  LockPackage,
  OpmLockfile,
} from './types.js';
import {
  inFileOrder,
  isLifecycleState,
  isNativeIntegrity,
  parseAliases,
  parseInstallName,
} from './lock-fields.js';
import { OpmError } from './types.js';

export function emptyLockfile(): OpmLockfile {
  return {
    schemaVersion: 1,
    generatedBy: 'opm',
    packages: {},
  };
}

export function serializeLockfile(lock: OpmLockfile): string {
  const packages: Record<string, LockPackage> = {};
  for (const alias of Object.keys(lock.packages).sort()) {
    const pkg = lock.packages[alias];
    if (!pkg) continue;
    packages[alias] = {
      ...pkg,
      purl: canonicalLockPurl(pkg.purl),
      bins: [...pkg.bins].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return `${JSON.stringify(
    {
      schemaVersion: lock.schemaVersion,
      generatedBy: lock.generatedBy,
      ...(!(lock.manifestDigest === undefined) && {
        manifestDigest: lock.manifestDigest,
      }),
      packages,
    },
    null,
    2,
  )}\n`;
}

export function parseLockfile(text: string): OpmLockfile {
  try {
    return parseLockfileBody(text);
  } catch (error) {
    if (error instanceof OpmError) throw error;
    throw new OpmError(
      'INVALID_LOCK',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function lockScalar(value: unknown): string {
  if (typeof value === 'string') return plainLine(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value === null) return 'null';
  try {
    return plainLine(JSON.stringify(value));
  } catch {
    return '[unprintable]';
  }
}

function lockAlias(alias: string): string {
  return plainLine(alias);
}

function parseLockfileBody(text: string): OpmLockfile {
  let value: unknown;
  try {
    value = parseCanonicalJson(text);
  } catch (error) {
    throw new OpmError(
      'INVALID_LOCK',
      `opm.lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpmError('INVALID_LOCK', 'opm.lock.json must be a JSON object');
  }
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new OpmError(
      'INVALID_LOCK',
      `Unsupported lock schemaVersion: ${lockScalar(record.schemaVersion)}`,
    );
  }
  if (record.generatedBy !== 'opm') {
    throw new OpmError(
      'INVALID_LOCK',
      `Unexpected generatedBy: ${lockScalar(record.generatedBy)}`,
    );
  }
  if (
    typeof record.packages !== 'object' ||
    record.packages === null ||
    Array.isArray(record.packages)
  ) {
    throw new OpmError('INVALID_LOCK', 'lock.packages must be an object');
  }
  const packages: Record<string, LockPackage> = {};
  for (const [alias, raw] of Object.entries(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    record.packages as Record<string, unknown>,
  )) {
    packages[alias] = parseLockPackage(alias, raw);
  }
  return {
    schemaVersion: 1,
    generatedBy: 'opm',
    ...(typeof record.manifestDigest === 'string' && {
      manifestDigest: record.manifestDigest,
    }),
    packages,
  };
}

function parseLockPackage(alias: string, raw: unknown): LockPackage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OpmError('INVALID_LOCK', `Invalid lock package entry: ${lockAlias(alias)}`);
  }
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const pkg = raw as Record<string, unknown>;
  const requiredString = (key: string): string => {
    const value = pkg[key];
    if (typeof value !== 'string' || value === '') {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${lockAlias(alias)}" missing string field ${key}`,
      );
    }
    return value;
  };
  const size = pkg.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new OpmError('INVALID_LOCK', `Package "${lockAlias(alias)}" has invalid size`);
  }
  const format = requiredString('format');
  if (format !== 'tar' && format !== 'tar+gzip' && format !== 'zip') {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has unsupported format ${plainLine(format)}`,
    );
  }
  const binsRaw = pkg.bins;
  if (!Array.isArray(binsRaw)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" bins must be an array`,
    );
  }
  const bins = binsRaw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${lockAlias(alias)}" bins[${index}] invalid`,
      );
    }
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const bin = entry as Record<string, unknown>;
    if (typeof bin.name !== 'string' || typeof bin.path !== 'string') {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${lockAlias(alias)}" bins[${index}] needs name and path`,
      );
    }
    // interpreter/entry ride along so a lock round-trip keeps how the bin
    // runs; an unknown value fails closed rather than silently becoming Node.
    const rawInterpreter = bin.interpreter;
    const interpreter: BinDeclaration['interpreter'] =
      rawInterpreter === 'node' ||
      rawInterpreter === 'python' ||
      rawInterpreter === 'dotnet' ||
      rawInterpreter === 'native'
        ? rawInterpreter
        : undefined;
    if (rawInterpreter !== undefined && interpreter === undefined) {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${lockAlias(alias)}" bins[${index}] has invalid interpreter`,
      );
    }
    const binEntry = bin.entry;
    if (binEntry !== undefined && typeof binEntry !== 'string') {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${lockAlias(alias)}" bins[${index}] has invalid entry`,
      );
    }
    return {
      name: bin.name,
      path: bin.path,
      ...(!(interpreter === undefined) && { interpreter }),
      ...(!(binEntry === undefined) && { entry: binEntry }),
    };
  });
  const reason = pkg.reason;
  if (reason !== 'direct' && reason !== 'transitive') {
    throw new OpmError('INVALID_LOCK', `Package "${lockAlias(alias)}" has invalid reason`);
  }
  if (pkg.trustLevel !== undefined && !isTrustTier(pkg.trustLevel)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid trustLevel`,
    );
  }
  if (pkg.sourceKind !== undefined && !isSourceKind(pkg.sourceKind)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid sourceKind`,
    );
  }
  if (
    pkg.publishedAt !== undefined &&
    (typeof pkg.publishedAt !== 'string' || pkg.publishedAt === '')
  ) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid publishedAt`,
    );
  }
  if (
    pkg.registryId !== undefined &&
    (typeof pkg.registryId !== 'string' || pkg.registryId === '')
  ) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid registryId`,
    );
  }
  if (pkg.lifecycle !== undefined && !isLifecycleState(pkg.lifecycle))
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid lifecycle`,
    );
  if (
    pkg.nativeIntegrity !== undefined &&
    !isNativeIntegrity(pkg.nativeIntegrity)
  )
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid nativeIntegrity`,
    );
  const attestation = parseAttestation(alias, pkg.attestation);
  if (
    pkg.dependencies !== undefined &&
    (!Array.isArray(pkg.dependencies) ||
      pkg.dependencies.some(
        (dependency) => typeof dependency !== 'string' || dependency === '',
      ))
  )
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid dependencies`,
    );
  const aliases = parseAliases(alias, pkg.aliases);
  const installName = parseInstallName(alias, pkg.installName);
  const built: LockPackage = {
    alias,
    purl: canonicalLockPurl(requiredString('purl')),
    version: requiredString('version'),
    digest: requiredString('digest'),
    size,
    format,
    mediaType: requiredString('mediaType'),
    source: requiredString('source'),
    storeKey: requiredString('storeKey'),
    bins,
    reason,
    ecosystem: requiredString('ecosystem'),
    ...(Array.isArray(pkg.dependencies) && {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      dependencies: [...new Set(pkg.dependencies as string[])].sort(),
    }),
    ...(!(aliases === undefined) && { aliases }),
    ...(!(installName === undefined) && { installName }),
    ...(isTrustTier(pkg.trustLevel) && { trustLevel: pkg.trustLevel }),
    ...(typeof pkg.publishedAt === 'string' && {
      publishedAt: pkg.publishedAt,
    }),
    ...(typeof pkg.registryId === 'string' && { registryId: pkg.registryId }),
    ...(isSourceKind(pkg.sourceKind) && { sourceKind: pkg.sourceKind }),
    ...(isLifecycleState(pkg.lifecycle) && { lifecycle: pkg.lifecycle }),
    ...(isNativeIntegrity(pkg.nativeIntegrity) && {
      nativeIntegrity: pkg.nativeIntegrity,
    }),
    ...(attestation !== undefined && { attestation }),
  };
  return inFileOrder(built, Object.keys(pkg));
}

const ATTESTATION_KEYS = new Set([
  'kind',
  'signerIdentity',
  'issuer',
  'signedAt',
  'signedAtVerified',
  'evidence',
  'record',
  'advancing',
]);

/**
 * Read a package's recorded signature evidence, refusing anything that is not
 * exactly the shape opm writes. The lock is committed and reviewed, and a field
 * nobody expects is either a typo or an attempt to say more than was verified.
 */
function parseAttestation(
  alias: string,
  value: unknown,
): LockAttestation | undefined {
  if (value === undefined) return undefined;
  const invalid = (why: string): OpmError =>
    new OpmError(
      'INVALID_LOCK',
      `Package "${lockAlias(alias)}" has invalid attestation: ${why}`,
    );
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid('it must be an object');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const attestation = value as Record<string, unknown>;
  for (const key of Object.keys(attestation))
    if (!ATTESTATION_KEYS.has(key)) throw invalid(`unknown field ${key}`);
  const text = (key: string): string => {
    const field = attestation[key];
    if (typeof field !== 'string' || field === '')
      throw invalid(`${key} must be a non-empty string`);
    return field;
  };
  const { issuer, signedAtVerified, evidence, record, advancing } = attestation;
  if (issuer !== undefined && (typeof issuer !== 'string' || issuer === ''))
    throw invalid('issuer must be a non-empty string');
  if (typeof signedAtVerified !== 'boolean')
    throw invalid('signedAtVerified must be a boolean');
  if (
    !Array.isArray(evidence) ||
    evidence.some((item) => typeof item !== 'string' || item === '')
  )
    throw invalid('evidence must be a list of non-empty strings');
  if (typeof record !== 'object' || record === null || Array.isArray(record))
    throw invalid('record must be an object');
  if (
    advancing !== undefined &&
    (!Array.isArray(advancing) ||
      advancing.some((key) => typeof key !== 'string' || key === ''))
  )
    throw invalid('advancing must be a list of non-empty strings');
  const signedAt = text('signedAt');
  if (Number.isNaN(Date.parse(signedAt)))
    throw invalid('signedAt must be a timestamp');
  return {
    kind: text('kind'),
    signerIdentity: text('signerIdentity'),
    ...(issuer !== undefined && { issuer }),
    signedAt,
    signedAtVerified,
    // SAFETY: checked above to be a list of strings.
    evidence: [...(evidence as string[])],
    // SAFETY: the lock is parsed from JSON, so an object here holds only JSON.
    record: record as LockAttestation['record'],
    // SAFETY: checked above to be a list of strings.
    ...(advancing !== undefined && { advancing: [...(advancing as string[])] }),
  };
}

export async function readLockfile(
  path: string,
): Promise<OpmLockfile | undefined> {
  try {
    return parseLockfile(await readStableFile(path));
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeLockfile(
  path: string,
  lock: OpmLockfile,
): Promise<void> {
  await writeStableFile(path, serializeLockfile(lock));
}
