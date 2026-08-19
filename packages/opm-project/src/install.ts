import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  descriptorForBytes,
  collectStream,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import type {
  BinDeclaration,
  InstalledPackageRecord,
  LockPackage,
  NativeIntegrity,
  OpmLockfile,
  ProjectState,
} from './types.js';
import { recordGeneration } from './generations.js';
import { OpmError } from './types.js';
import {
  discoverBins,
  discoverNpmBins,
  removeBinShims,
  writeBinShims,
} from './bins.js';
import {
  assertSafeSegment,
  assertStoreKey,
  ensureStableDirectory,
  openStableDirectory,
  projectPaths,
  readStableFile,
  revalidateStableDirectory,
  removeStableFile,
  removeStableTree,
  resolveContained,
  storeKeyFromDigest,
  storePathForDigest,
  stableHandlePath,
  writeStableFile,
  writeStableFileAt,
} from './paths.js';
import {
  detectNpmLifecycleScripts,
  hasLifecycleScripts,
  lifecycleScriptsAllowed,
  runDeclaredLifecycleScripts,
} from './lifecycle.js';
import type { PolicyInput } from '@openpacker/contracts';
import { digestSandboxPolicy, type SandboxOutcome } from '@openpacker/sandbox';
import { sandboxPolicyFromProject } from './lifecycle.js';

export async function emptyProjectState(): Promise<ProjectState> {
  return { schemaVersion: 1, packages: {} };
}

export async function readProjectState(
  path: string,
): Promise<ProjectState | undefined> {
  let text: string;
  try {
    text = await readStableFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return await validateProjectState(JSON.parse(text) as unknown, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw invalidState('a referenced path disappeared during validation');
    throw error;
  }
}

async function validateProjectState(
  value: unknown,
  statePath: string,
): Promise<ProjectState> {
  const state = objectValue(value, 'project state');
  if (state.schemaVersion !== 1) throw invalidState('schemaVersion must be 1');
  const packages = objectValue(state.packages, 'packages');
  const root = dirname(dirname(resolve(statePath)));
  const paths = projectPaths(root);
  if (resolve(statePath) !== paths.projectState)
    throw invalidState(`state path must be ${paths.projectState}`);
  await assertRealDirectory(paths.opmDir, 'project metadata directory');
  const realStoreRoot = await assertRealDirectory(paths.store, 'project store');
  await assertRealDirectory(paths.bin, 'project bin directory');
  await assertRealDirectory(paths.links, 'project links directory');
  const validated: ProjectState['packages'] = {};

  for (const [key, raw] of Object.entries(packages)) {
    const alias = assertSafeSegment(key, 'package alias');
    const record = objectValue(raw, `package ${alias}`);
    if (record.alias !== alias)
      throw invalidState(`package ${alias} has a contradictory alias`);
    const purl = stringValue(record.purl, `${alias}.purl`);
    if (!purl.startsWith('pkg:'))
      throw invalidState(`${alias}.purl must be a package URL`);
    const digest = stringValue(record.digest, `${alias}.digest`);
    const expectedStore = storePathForDigest(root, digest);
    if (record.storePath !== expectedStore)
      throw invalidState(`${alias}.storePath is not derived from its digest`);
    const realPackage = await assertRealDirectory(
      expectedStore,
      `${alias} store path`,
    );
    if (!isContained(realStoreRoot, realPackage))
      throw invalidState(`${alias}.storePath escapes the project store`);
    if (!Array.isArray(record.bins))
      throw invalidState(`${alias}.bins must be an array`);
    const bins: InstalledPackageRecord['bins'][number][] = [];
    for (const [index, rawBin] of record.bins.entries()) {
      const bin = objectValue(rawBin, `${alias}.bins[${index}]`);
      const name = assertSafeSegment(
        stringValue(bin.name, `${alias}.bins[${index}].name`),
        'bin name',
      );
      const binPath = stringValue(bin.path, `${alias}.bins[${index}].path`);
      const segments = binPath
        .split(/[/\\]/u)
        .filter((part) => part !== '' && part !== '.');
      if (segments.length === 0 || segments.includes('..'))
        throw invalidState(`${alias}.bins[${index}].path escapes its store`);
      const target = resolveContained(expectedStore, ...segments);
      if (bin.target !== target)
        throw invalidState(`${alias}.bins[${index}].target is not derived`);
      const shim = resolveContained(paths.bin, name);
      if (bin.shim !== shim)
        throw invalidState(`${alias}.bins[${index}].shim is not derived`);
      const targetInfo = await lstat(target).catch(() => undefined);
      if (!targetInfo?.isFile() || targetInfo.isSymbolicLink())
        throw invalidState(`${alias}.bins[${index}].target is not a file`);
      const realTarget = await realpath(target);
      if (!isContained(realPackage, realTarget))
        throw invalidState(`${alias}.bins[${index}].target escapes its store`);
      bins.push({ name, path: binPath, shim, target });
    }
    const installedAt = stringValue(record.installedAt, `${alias}.installedAt`);
    if (!Number.isFinite(Date.parse(installedAt)))
      throw invalidState(`${alias}.installedAt is not a timestamp`);
    if (
      record.lifecycleScriptsExecuted !== undefined &&
      typeof record.lifecycleScriptsExecuted !== 'boolean'
    )
      throw invalidState(`${alias}.lifecycleScriptsExecuted must be boolean`);
    if (
      record.sandboxEnforced !== undefined &&
      typeof record.sandboxEnforced !== 'boolean'
    )
      throw invalidState(`${alias}.sandboxEnforced must be boolean`);
    if (
      record.sandboxBackend !== undefined &&
      typeof record.sandboxBackend !== 'string'
    )
      throw invalidState(`${alias}.sandboxBackend must be a string`);
    validated[alias] = {
      alias,
      purl,
      digest,
      storePath: expectedStore,
      bins,
      installedAt,
      ...(record.lifecycleScriptsExecuted === undefined
        ? {}
        : { lifecycleScriptsExecuted: record.lifecycleScriptsExecuted }),
      ...(record.sandboxBackend === undefined
        ? {}
        : { sandboxBackend: record.sandboxBackend }),
      ...(record.sandboxEnforced === undefined
        ? {}
        : { sandboxEnforced: record.sandboxEnforced }),
    };
  }
  return { schemaVersion: 1, packages: validated };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidState(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw invalidState(`${name} must be a non-empty string`);
  return value;
}

async function assertRealDirectory(
  path: string,
  name: string,
): Promise<string> {
  const handle = await openStableDirectory(path).catch(() => undefined);
  if (!handle)
    throw invalidState(`${name} is missing, linked, or not a directory`);
  try {
    return await realpath(stableHandlePath(handle));
  } finally {
    await handle.close();
  }
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function invalidState(message: string): OpmError {
  return new OpmError('INVALID_STATE', `Invalid project state: ${message}`);
}

export async function writeProjectState(
  path: string,
  state: ProjectState,
): Promise<void> {
  await writeStableFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function fetchArtifactBytes(
  source: string,
  offline: boolean,
  options: {
    expectedBytes?: number;
    maximumBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Uint8Array> {
  const absoluteMaximum = 512 * 1024 * 1024;
  const maximumBytes = options.maximumBytes ?? absoluteMaximum;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > absoluteMaximum
  )
    throw new RangeError(
      `Artifact byte limit must be between 0 and ${absoluteMaximum}`,
    );
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) ||
      options.expectedBytes < 0 ||
      options.expectedBytes > maximumBytes)
  )
    throw new OpmError(
      'SIZE_LIMIT',
      `Expected artifact size exceeds ${maximumBytes} bytes`,
    );
  const limit = options.expectedBytes ?? maximumBytes;
  if (source.startsWith('https:') || source.startsWith('http:')) {
    if (offline) {
      throw new OpmError(
        'OFFLINE',
        `Refusing network fetch for ${source} while offline`,
      );
    }
    const response = await fetch(source, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      throw new OpmError(
        'FETCH_FAILED',
        `Failed to fetch ${source}: HTTP ${response.status}`,
      );
    }
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/u.test(declared) || Number(declared) > limit)
    )
      throw new OpmError(
        'SIZE_LIMIT',
        `Artifact response exceeds ${limit} bytes`,
      );
    if (!response.body)
      throw new OpmError('FETCH_FAILED', `Artifact response has no body`);
    let bytes: Uint8Array;
    try {
      bytes = await collectStream(response.body, limit, options.signal);
    } catch (error) {
      if (error instanceof RangeError)
        throw new OpmError(
          'SIZE_LIMIT',
          `Artifact response exceeds ${limit} bytes`,
        );
      throw error;
    }
    assertExpectedSize(bytes.byteLength, options.expectedBytes);
    return bytes;
  }
  // file path
  const path = source.startsWith('file:')
    ? fileURLToPath(source)
    : resolve(source);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new OpmError(
        'UNSAFE_SOURCE',
        `Artifact source is not a regular file: ${path}`,
      );
    if (before.size > BigInt(limit))
      throw new OpmError(
        'SIZE_LIMIT',
        `Artifact source exceeds ${limit} bytes`,
      );
    const size = Number(before.size);
    assertExpectedSize(size, options.expectedBytes);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        size - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new OpmError(
        'INPUT_CHANGED',
        `Artifact source changed while it was read: ${path}`,
      );
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpmError('NOT_FOUND', `Artifact source not found: ${path}`);
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new OpmError(
        'UNSAFE_SOURCE',
        `Artifact source must not be a symbolic link: ${path}`,
      );
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertExpectedSize(
  actual: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && actual !== expected)
    throw new OpmError(
      'SIZE_MISMATCH',
      `Artifact has ${actual} bytes, expected ${expected}`,
    );
}

export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The integrity value this ecosystem's own lockfile pins with.
 *
 * PREX pins with sha256 hex, but no native lockfile uses that: npm writes an
 * SRI string, NuGet a base64 sha512, Cargo a sha256 hex, Go a dirhash. It is
 * computed here, where the archive bytes are in hand, because materialize
 * extracts the archive and does not keep it — after that there is nothing left
 * to hash, and a lockfile written from an invented value is worse than none.
 *
 * An ecosystem with no scheme this can produce returns undefined, and the
 * lockfile projection refuses to write rather than guessing.
 */
export function nativeIntegrityOf(
  ecosystem: string,
  bytes: Uint8Array,
): NativeIntegrity | undefined {
  switch (ecosystem) {
    case 'npm':
      // package-lock.json `integrity` is Subresource Integrity. npm writes
      // sha512 and verifies whatever algorithm the string names.
      return {
        algorithm: 'sha512',
        value: createHash('sha512').update(bytes).digest('base64'),
        encoding: 'sri',
      };
    case 'nuget':
      // packages.lock.json `contentHash` is base64 sha512 of the .nupkg.
      return {
        algorithm: 'sha512',
        value: createHash('sha512').update(bytes).digest('base64'),
        encoding: 'base64',
      };
    case 'cargo':
      // Cargo.lock `checksum` is lowercase sha256 hex of the .crate.
      return {
        algorithm: 'sha256',
        value: createHash('sha256').update(bytes).digest('hex'),
        encoding: 'hex',
      };
    default:
      // golang's h1: is a hash over a directory listing rather than the
      // archive, and maven/pypi lockfiles are not written by this yet. Absent
      // is the honest answer.
      return undefined;
  }
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
  /**
   * Bytes already fetched and verified by the caller.
   *
   * Supplied by the ephemeral runner, whose provider downloaded them and
   * checked them against the registry's own integrity claim to derive the
   * digest. Fetching again would cost a second transfer and compare new bytes
   * against a digest taken from the old ones. They are re-hashed below either
   * way, so this is a transfer saving and not a trust shortcut.
   */
  bytes?: Uint8Array;
  /** Project policy for lifecycle jail decisions. */
  policy?: PolicyInput;
}): Promise<{
  storePath: string;
  bins: BinDeclaration[];
  cached: boolean;
  lifecycleScriptsExecuted: boolean;
  sandboxOutcomes: SandboxOutcome[];
}> {
  const paths = projectPaths(input.root);
  // Always derive store path from verified digest shape; never trust lock storeKey alone.
  assertStoreKey(input.pkg.storeKey, input.pkg.digest);
  const storePath = storePathForDigest(input.root, input.pkg.digest);
  const archivePath = `${storePath}.artifact`;
  await ensureStableDirectory(paths.opmDir);
  await ensureStableDirectory(paths.store);
  const storeHandle = await openStableDirectory(paths.store);
  try {
    const stableStorePath = join(
      stableHandlePath(storeHandle),
      basename(storePath),
    );
    const stableArchivePath = `${stableStorePath}.artifact`;
    let cached = false;
    let bytes = input.bytes;
    if (bytes === undefined && !input.force) {
      try {
        bytes = await fetchArtifactBytes(stableArchivePath, true, {
          expectedBytes: input.pkg.size,
        });
        cached = true;
      } catch (error) {
        if (!(error instanceof OpmError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    }
    bytes ??= await fetchArtifactBytes(input.pkg.source, input.offline, {
      expectedBytes: input.pkg.size,
    });
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

    await rm(stableStorePath, { recursive: true, force: true });
    await materialize({
      source: bytesSource(bytes),
      descriptor,
      destination: stableStorePath,
      format: input.pkg.format as ArchiveFormat,
    });

    let lifecycleScriptsExecuted = false;
    let sandboxOutcomes: SandboxOutcome[] = [];
    // Lifecycle scripts: default never run. When allowlisted, run only in jail.
    if (input.pkg.ecosystem === 'npm') {
      const declared = await detectNpmLifecycleScripts(stableStorePath);
      if (
        hasLifecycleScripts(declared) &&
        lifecycleScriptsAllowed(input.policy, input.pkg.purl)
      ) {
        const result = await runDeclaredLifecycleScripts({
          declared,
          packageDir: stableStorePath,
          packageId: input.pkg.purl,
          policy: input.policy,
        });
        lifecycleScriptsExecuted = result.executed;
        sandboxOutcomes = result.outcomes;
      }
    }
    if (!cached || input.force)
      await writeStableFileAt(
        storeHandle,
        basename(archivePath),
        bytes,
        0o444,
        archivePath,
      );

    const bins: BinDeclaration[] =
      input.pkg.bins.length > 0
        ? [...input.pkg.bins]
        : await discoverBins(stableStorePath, input.pkg.ecosystem);
    await revalidateStableDirectory(paths.store, storeHandle);
    return {
      storePath,
      bins,
      cached,
      lifecycleScriptsExecuted,
      sandboxOutcomes,
    };
  } finally {
    await storeHandle.close();
  }
}

export async function installFromLock(input: {
  root: string;
  lock: OpmLockfile;
  offline: boolean;
  only?: readonly string[];
  policy?: PolicyInput;
}): Promise<ProjectState> {
  const paths = projectPaths(input.root);
  await ensureStableDirectory(paths.opmDir);
  await ensureStableDirectory(paths.bin);
  await ensureStableDirectory(paths.links);

  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };

  const aliases =
    input.only ??
    Object.keys(input.lock.packages).sort((a, b) => a.localeCompare(b));

  // Materialise every package first so Python shims can see the full set of
  // store roots (transitive deps must be importable when a console script
  // runs).
  const materialised = new Map<
    string,
    {
      storePath: string;
      bins: BinDeclaration[];
      pkg: LockPackage;
      lifecycleScriptsExecuted: boolean;
      sandboxOutcomes: SandboxOutcome[];
    }
  >();
  for (const alias of aliases) {
    const safeAlias = assertSafeSegment(alias, 'package alias');
    const pkg = input.lock.packages[alias];
    if (!pkg) {
      throw new OpmError('NOT_FOUND', `Lock entry missing for ${alias}`);
    }
    const { storePath, bins, lifecycleScriptsExecuted, sandboxOutcomes } =
      await materializeLockPackage({
        root: input.root,
        pkg,
        offline: input.offline,
        ...(input.policy === undefined ? {} : { policy: input.policy }),
      });
    materialised.set(safeAlias, {
      storePath,
      bins,
      pkg,
      lifecycleScriptsExecuted,
      sandboxOutcomes,
    });
  }

  const pythonStoreRoots = [...materialised.values()]
    .filter(({ pkg }) => pkg.ecosystem === 'pypi')
    .map(({ storePath }) => storePath);

  let anyLifecycle = false;
  const sandboxOutcomes: SandboxOutcome[] = [];
  for (const [
    alias,
    {
      storePath,
      bins,
      pkg,
      lifecycleScriptsExecuted,
      sandboxOutcomes: observed,
    },
  ] of materialised) {
    sandboxOutcomes.push(...observed);
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
      ...(pkg.ecosystem === 'pypi' ? { pythonPath: pythonStoreRoots } : {}),
    });

    await writeStableFile(
      resolveContained(paths.links, alias),
      `${JSON.stringify({ alias, purl: pkg.purl, storePath, digest: pkg.digest }, null, 2)}\n`,
    );

    if (lifecycleScriptsExecuted) anyLifecycle = true;
    const record: InstalledPackageRecord = {
      alias,
      purl: pkg.purl,
      digest: pkg.digest,
      storePath,
      bins: shims,
      installedAt: new Date().toISOString(),
      lifecycleScriptsExecuted,
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
    sandbox: await observedSandboxForGeneration({
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      lifecycleScriptsExecuted: anyLifecycle,
      outcomes: sandboxOutcomes,
    }),
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
    await removeStableFile(resolveContained(paths.links, safeAlias));
    if (input.removeStore) {
      await removeStableTree(record.storePath);
      await removeStableFile(`${record.storePath}.artifact`);
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

export async function observedSandboxForGeneration(input: {
  policy?: PolicyInput;
  lifecycleScriptsExecuted: boolean;
  outcomes: readonly SandboxOutcome[];
}): Promise<{
  policyDigest: string;
  lifecycleScriptsExecuted: boolean;
  backends?: string[];
  enforced?: boolean;
}> {
  const digest = await digestSandboxPolicy(
    sandboxPolicyFromProject(input.policy),
  );
  const backends = [
    ...new Set(input.outcomes.map((outcome) => outcome.backend)),
  ].sort();
  return {
    policyDigest: `${digest.algorithm}:${digest.value}`,
    lifecycleScriptsExecuted: input.lifecycleScriptsExecuted,
    ...(backends.length > 0 ? { backends } : {}),
    ...(input.lifecycleScriptsExecuted
      ? {
          enforced:
            input.outcomes.length > 0 &&
            input.outcomes.every((outcome) => outcome.enforced),
        }
      : {}),
  };
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
  await removeStableTree(paths.bin);
  await ensureStableDirectory(paths.bin);
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

export function inferFormat(source: string, mediaType?: string): ArchiveFormat {
  const lower = source.toLowerCase();
  // Gzip first: media types like "...+gzip" also contain "zip" and must not
  // be classified as zip archives. Plain `.tar` / `...layout.v1.tar` is
  // uncompressed — matching on the substring "tar" alone would mis-label an
  // OCI image layout as gzip and fail extraction.
  if (
    mediaType?.includes('gzip') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.crate')
  )
    return 'tar+gzip';
  if (
    mediaType === 'application/x-tar' ||
    mediaType === 'application/vnd.oci.image.layout.v1.tar' ||
    (mediaType?.includes('tar') && !mediaType.includes('gzip')) ||
    (lower.endsWith('.tar') && !lower.endsWith('.tar.gz'))
  )
    return 'tar';
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
    case 'oci':
      return 'application/vnd.oci.image.layout.v1.tar';
    default:
      return 'application/octet-stream';
  }
}
