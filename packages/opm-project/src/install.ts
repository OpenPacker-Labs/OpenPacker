import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import type {
  BinDeclaration,
  InstalledPackageRecord,
  LockPackage,
  OpmLockfile,
  ProjectState,
} from './types.js';
import { recordGeneration } from './generations.js';
import { OpmError } from './types.js';
import { discoverNpmBins, removeBinShims, writeBinShims } from './bins.js';
import {
  assertSafeSegment,
  assertStoreKey,
  projectPaths,
  resolveContained,
  storeKeyFromDigest,
  storePathForDigest,
} from './paths.js';

export async function emptyProjectState(): Promise<ProjectState> {
  return { schemaVersion: 1, packages: {} };
}

export async function readProjectState(
  path: string,
): Promise<ProjectState | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as ProjectState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeProjectState(
  path: string,
  state: ProjectState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function fetchArtifactBytes(
  source: string,
  offline: boolean,
): Promise<Uint8Array> {
  if (source.startsWith('https:') || source.startsWith('http:')) {
    if (offline) {
      throw new OpmError(
        'OFFLINE',
        `Refusing network fetch for ${source} while offline`,
      );
    }
    const response = await fetch(source);
    if (!response.ok) {
      throw new OpmError(
        'FETCH_FAILED',
        `Failed to fetch ${source}: HTTP ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  // file path
  const path = source.startsWith('file:')
    ? fileURLToPath(source)
    : resolve(source);
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpmError('NOT_FOUND', `Artifact source not found: ${path}`);
    }
    throw error;
  }
}

export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bytesSource(bytes: Uint8Array): ArtifactSource {
  return {
    async stat(descriptor) {
      return { descriptor, rangeSupported: false };
    },
    async open() {
      return streamFromBytes(bytes);
    },
    async listReferrers() {
      return [];
    },
  };
}

export async function materializeLockPackage(input: {
  root: string;
  pkg: LockPackage;
  offline: boolean;
  force?: boolean;
}): Promise<{ storePath: string; bins: BinDeclaration[] }> {
  const paths = projectPaths(input.root);
  // Always derive store path from verified digest shape; never trust lock storeKey alone.
  assertStoreKey(input.pkg.storeKey, input.pkg.digest);
  const storePath = storePathForDigest(input.root, input.pkg.digest);
  const already = await pathExists(storePath);
  if (already && !input.force) {
    const bins =
      input.pkg.bins.length > 0
        ? [...input.pkg.bins]
        : await discoverNpmBins(storePath);
    return { storePath, bins };
  }
  if (already && input.force) {
    await rm(storePath, { recursive: true, force: true });
  }

  await mkdir(paths.store, { recursive: true });
  const bytes = await fetchArtifactBytes(input.pkg.source, input.offline);
  const actual = digestOf(bytes);
  if (actual !== input.pkg.digest) {
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Digest mismatch for ${input.pkg.alias}: expected ${input.pkg.digest}, got ${actual}`,
    );
  }
  if (bytes.byteLength !== input.pkg.size) {
    throw new OpmError(
      'SIZE_MISMATCH',
      `Size mismatch for ${input.pkg.alias}: expected ${input.pkg.size}, got ${bytes.byteLength}`,
    );
  }

  const descriptor = await descriptorForBytes({
    bytes,
    descriptorId: input.pkg.storeKey,
    mediaType: input.pkg.mediaType,
    artifactType: 'package',
    nativeRole: 'native-package',
  });

  await materialize({
    source: bytesSource(bytes),
    descriptor,
    destination: storePath,
    format: input.pkg.format as ArchiveFormat,
    managedDestination: true,
  });

  let bins: BinDeclaration[] =
    input.pkg.bins.length > 0
      ? [...input.pkg.bins]
      : await discoverNpmBins(storePath);
  return { storePath, bins };
}

export async function installFromLock(input: {
  root: string;
  lock: OpmLockfile;
  offline: boolean;
  only?: readonly string[];
}): Promise<ProjectState> {
  const paths = projectPaths(input.root);
  await mkdir(paths.opmDir, { recursive: true });
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.links, { recursive: true });

  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };

  const aliases =
    input.only ??
    Object.keys(input.lock.packages).sort((a, b) => a.localeCompare(b));

  for (const alias of aliases) {
    const safeAlias = assertSafeSegment(alias, 'package alias');
    const pkg = input.lock.packages[alias];
    if (!pkg) {
      throw new OpmError('NOT_FOUND', `Lock entry missing for ${alias}`);
    }
    const { storePath, bins } = await materializeLockPackage({
      root: input.root,
      pkg,
      offline: input.offline,
    });

    // refresh bins in .opm/bin
    const previous = state.packages[alias];
    if (previous) {
      await removeBinShims(
        paths.bin,
        previous.bins.map((b) => b.name),
      );
    }

    const shims = await writeBinShims({
      binDir: paths.bin,
      storeRoot: storePath,
      bins,
    });

    // link record
    await writeFile(
      resolveContained(paths.links, safeAlias),
      `${JSON.stringify({ alias: safeAlias, purl: pkg.purl, storePath, digest: pkg.digest }, null, 2)}\n`,
      'utf8',
    );

    const record: InstalledPackageRecord = {
      alias,
      purl: pkg.purl,
      digest: pkg.digest,
      storePath,
      bins: shims,
      installedAt: new Date().toISOString(),
    };
    state.packages[alias] = record;
  }

  await writeProjectState(paths.projectState, state);
  // Every install appends an immutable generation, which is what makes the
  // result rollback-able rather than a destructive overwrite.
  await recordGeneration({
    root: input.root,
    packages: state.packages,
    lockDigest: digestOf(
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state.packages)
              .map(([alias, record]): [string, string] => [
                alias,
                record.digest,
              ])
              .sort(([left], [right]) => (left < right ? -1 : 1)),
          ),
        ),
      ),
    ),
  });
  return state;
}

export async function uninstallPackages(input: {
  root: string;
  aliases: readonly string[];
  removeStore?: boolean;
}): Promise<ProjectState> {
  const paths = projectPaths(input.root);
  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };

  for (const alias of input.aliases) {
    const safeAlias = assertSafeSegment(alias, 'package alias');
    const record = state.packages[alias] ?? state.packages[safeAlias];
    if (!record) continue;
    await removeBinShims(
      paths.bin,
      record.bins.map((b) => b.name),
    );
    await rm(resolveContained(paths.links, safeAlias), { force: true });
    if (input.removeStore) {
      await rm(record.storePath, { recursive: true, force: true });
    }
    delete state.packages[alias];
    delete state.packages[safeAlias];
  }
  await writeProjectState(paths.projectState, state);
  // Removing packages changes the environment, so it is a new generation for
  // the same reason installing is: the previous state stays rollback-able.
  await recordGeneration({
    root: input.root,
    packages: state.packages,
    lockDigest: digestOf(
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state.packages)
              .map(([alias, record]): [string, string] => [
                alias,
                record.digest,
              ])
              .sort(([left], [right]) => (left < right ? -1 : 1)),
          ),
        ),
      ),
    ),
  });
  return state;
}

export async function uninstallAll(root: string): Promise<void> {
  const paths = projectPaths(root);
  const state = await readProjectState(paths.projectState);
  if (state) {
    await uninstallPackages({
      root,
      aliases: Object.keys(state.packages),
      removeStore: false,
    });
  }
  // clear bin dir shims
  await rm(paths.bin, { recursive: true, force: true });
  await mkdir(paths.bin, { recursive: true });
}

export function lockPackageFromSource(input: {
  alias: string;
  purl: string;
  version: string;
  ecosystem: string;
  bytes: Uint8Array;
  source: string;
  format: ArchiveFormat;
  mediaType: string;
  bins?: readonly BinDeclaration[];
  reason?: 'direct' | 'transitive';
}): LockPackage {
  const digest = digestOf(input.bytes);
  return {
    alias: input.alias,
    purl: input.purl,
    version: input.version,
    digest,
    size: input.bytes.byteLength,
    format: input.format,
    mediaType: input.mediaType,
    source: input.source,
    storeKey: storeKeyFromDigest(digest),
    bins: input.bins ? [...input.bins] : [],
    reason: input.reason ?? 'direct',
    ecosystem: input.ecosystem,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function inferFormat(source: string, mediaType?: string): ArchiveFormat {
  const lower = source.toLowerCase();
  // Check gzip/tarball before zip: media types like "...+gzip" contain the
  // substring "zip" and must not be classified as zip archives.
  if (
    mediaType?.includes('gzip') ||
    mediaType?.includes('tar') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.crate')
  )
    return 'tar+gzip';
  if (
    mediaType === 'application/zip' ||
    mediaType?.includes('zip') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.nupkg') ||
    lower.endsWith('.whl')
  )
    return 'zip';
  return 'tar';
}

export function mediaTypeForEcosystem(ecosystem: string): string {
  switch (ecosystem) {
    case 'npm':
      return 'application/vnd.npm.package+gzip';
    case 'cargo':
      return 'application/vnd.crates.io.crate+gzip';
    case 'nuget':
      return 'application/vnd.nuget.package+zip';
    case 'pypi':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
