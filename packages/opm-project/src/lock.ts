import { readFile, writeFile } from 'node:fs/promises';
import { isSourceKind, isTrustTier } from '@openpacker/policy';
import type { LockPackage, OpmLockfile } from './types.js';
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
      bins: [...pkg.bins].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return `${JSON.stringify(
    {
      schemaVersion: lock.schemaVersion,
      generatedBy: lock.generatedBy,
      packages,
    },
    null,
    2,
  )}\n`;
}

export function parseLockfile(text: string): OpmLockfile {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpmError(
      'INVALID_LOCK',
      `opm.lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpmError('INVALID_LOCK', 'opm.lock.json must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new OpmError(
      'INVALID_LOCK',
      `Unsupported lock schemaVersion: ${String(record.schemaVersion)}`,
    );
  }
  if (record.generatedBy !== 'opm') {
    throw new OpmError(
      'INVALID_LOCK',
      `Unexpected generatedBy: ${String(record.generatedBy)}`,
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
    record.packages as Record<string, unknown>,
  )) {
    packages[alias] = parseLockPackage(alias, raw);
  }
  return {
    schemaVersion: 1,
    generatedBy: 'opm',
    packages,
  };
}

function parseLockPackage(alias: string, raw: unknown): LockPackage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OpmError('INVALID_LOCK', `Invalid lock package entry: ${alias}`);
  }
  const pkg = raw as Record<string, unknown>;
  const requiredString = (key: string): string => {
    const value = pkg[key];
    if (typeof value !== 'string' || value === '') {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${alias}" missing string field ${key}`,
      );
    }
    return value;
  };
  const size = pkg.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new OpmError('INVALID_LOCK', `Package "${alias}" has invalid size`);
  }
  const format = requiredString('format');
  if (format !== 'tar' && format !== 'tar+gzip' && format !== 'zip') {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has unsupported format ${format}`,
    );
  }
  const binsRaw = pkg.bins;
  if (!Array.isArray(binsRaw)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" bins must be an array`,
    );
  }
  const bins = binsRaw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${alias}" bins[${index}] invalid`,
      );
    }
    const bin = entry as Record<string, unknown>;
    if (typeof bin.name !== 'string' || typeof bin.path !== 'string') {
      throw new OpmError(
        'INVALID_LOCK',
        `Package "${alias}" bins[${index}] needs name and path`,
      );
    }
    return { name: bin.name, path: bin.path };
  });
  const reason = pkg.reason;
  if (reason !== 'direct' && reason !== 'transitive') {
    throw new OpmError('INVALID_LOCK', `Package "${alias}" has invalid reason`);
  }
  if (pkg.trustLevel !== undefined && !isTrustTier(pkg.trustLevel)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid trustLevel`,
    );
  }
  if (pkg.sourceKind !== undefined && !isSourceKind(pkg.sourceKind)) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid sourceKind`,
    );
  }
  if (
    pkg.publishedAt !== undefined &&
    (typeof pkg.publishedAt !== 'string' || pkg.publishedAt === '')
  ) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid publishedAt`,
    );
  }
  if (
    pkg.registryId !== undefined &&
    (typeof pkg.registryId !== 'string' || pkg.registryId === '')
  ) {
    throw new OpmError(
      'INVALID_LOCK',
      `Package "${alias}" has invalid registryId`,
    );
  }
  return {
    alias: typeof pkg.alias === 'string' ? pkg.alias : alias,
    purl: requiredString('purl'),
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
    ...(isTrustTier(pkg.trustLevel) ? { trustLevel: pkg.trustLevel } : {}),
    ...(typeof pkg.publishedAt === 'string'
      ? { publishedAt: pkg.publishedAt }
      : {}),
    ...(typeof pkg.registryId === 'string'
      ? { registryId: pkg.registryId }
      : {}),
    ...(isSourceKind(pkg.sourceKind) ? { sourceKind: pkg.sourceKind } : {}),
  };
}

export async function readLockfile(
  path: string,
): Promise<OpmLockfile | undefined> {
  try {
    return parseLockfile(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeLockfile(
  path: string,
  lock: OpmLockfile,
): Promise<void> {
  await writeFile(path, serializeLockfile(lock), 'utf8');
}
