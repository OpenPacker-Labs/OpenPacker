import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  descriptorForBytes,
  collectStream,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { echoed, redactAddress } from '@openpacker/adapter-core';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import {
  freezeBoundLockPackage,
  immutablePlainData,
  lockPackageBinding,
} from './lock-authority.js';
import type {
  BinDeclaration,
  InstalledPackageRecord,
  LockPackage,
  NativeIntegrity,
  OpmLockfile,
  ProjectState,
} from './types.js';
import { recordGeneration, stableStoreTreeDigest } from './generations.js';
import {
  isolateProjectStoreFromSharedLinks,
  materializeThroughSharedStore,
  usableSharedRoot,
} from './shared-store.js';
import { OpmError } from './types.js';
import { discoverBins, removeBinShims, writeBinShims } from './bins.js';
import {
  assertSafeSegment,
  O_DIRECTORY,
  assertStoreKey,
  ensureStableDirectory,
  openStableDirectory,
  OPM_DIR,
  PROJECT_STATE,
  projectPaths,
  openChild,
  readStableFile,
  readStableFileBytesAt,
  revalidateStableDirectory,
  removeChild,
  renameChild,
  removeStableFile,
  removeStableTree,
  resolveContained,
  storeKeyFromDigest,
  storePathForDigest,
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
import {
  assertLockPackageAllowed,
  captureFactsFromSourceUri,
  type PolicyFacts,
} from './supply-chain.js';

interface VerifiedArtifactCapability {
  /**
   * Absent only for a cache-entry binding: the bytes are then read from the
   * content-addressed store archive at materialization and hashed against
   * the bound digest there — the same verification, where the bytes are.
   */
  bytes?: Uint8Array;
  provenance: 'direct' | 'registry';
  facts?: PolicyFacts;
  packageBinding: string;
}

const verifiedArtifacts = new WeakMap<
  LockPackage,
  VerifiedArtifactCapability
>();
const manifestSourceAuthorities = new WeakMap<LockPackage, string>();

/** Bind a source only after project.ts matched it to the current manifest. */
export function bindManifestSourceAuthority(pkg: LockPackage): void {
  manifestSourceAuthorities.set(pkg, freezeBoundLockPackage(pkg));
}

/** Bind resolution-verified bytes to the exact in-memory lock entry. */
export function bindVerifiedArtifactBytes(
  pkg: LockPackage,
  bytes: Uint8Array,
  provenance: VerifiedArtifactCapability['provenance'],
  facts?: PolicyFacts,
): void {
  verifiedArtifacts.set(pkg, {
    bytes: Uint8Array.from(bytes),
    provenance,
    packageBinding: '',
    ...(!(facts === undefined) && {
      facts: immutablePlainData(facts, 'policy facts'),
    }),
  });
}

/** Seal only after resolution has finished constructing the lock entry. */
export function sealVerifiedArtifactBinding(pkg: LockPackage): void {
  const capability = verifiedArtifacts.get(pkg);
  if (capability !== undefined)
    capability.packageBinding = freezeBoundLockPackage(pkg);
}

/**
 * Bind resolution-verified facts without bytes, for a package whose bytes
 * the content-addressed store archive already holds. The facts come from the
 * same fresh registry resolution as a download run — never from stored data —
 * and the archive bytes are hashed against the bound digest when they are
 * read at materialization, so the verification posture is unchanged; only
 * the transfer is saved.
 */
export function bindVerifiedArtifactCacheEntry(
  pkg: LockPackage,
  facts?: PolicyFacts,
): void {
  verifiedArtifacts.set(pkg, {
    provenance: 'registry',
    packageBinding: '',
    ...(!(facts === undefined) && {
      facts: immutablePlainData(facts, 'policy facts'),
    }),
  });
}

function verifiedArtifactFor(
  pkg: LockPackage,
): VerifiedArtifactCapability | undefined {
  const capability = verifiedArtifacts.get(pkg);
  if (capability === undefined) return undefined;
  try {
    return capability.packageBinding === lockPackageBinding(pkg)
      ? capability
      : undefined;
  } catch {
    return undefined;
  }
}

function manifestSourceVerified(pkg: LockPackage): boolean {
  const binding = manifestSourceAuthorities.get(pkg);
  if (binding === undefined) return false;
  try {
    return binding === lockPackageBinding(pkg);
  } catch {
    return false;
  }
}

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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return await validateProjectState(JSON.parse(text) as unknown, path);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
  // The state file is only ever <root>/.opm/project.json. Validate those
  // segments directly instead of deriving a root from statePath and
  // round-tripping it through projectPaths, which was true by construction.
  const stateDir = dirname(resolve(statePath));
  if (basename(stateDir) !== OPM_DIR || basename(statePath) !== PROJECT_STATE)
    throw invalidState(`state path must be <root>/${OPM_DIR}/${PROJECT_STATE}`);
  const root = dirname(stateDir);
  const paths = projectPaths(root);
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
      // interpreter/entry ride along exactly as the lock carries them; an
      // unknown value fails closed rather than silently becoming Node.
      const interpreter = bin.interpreter;
      if (
        interpreter !== undefined &&
        interpreter !== 'node' &&
        interpreter !== 'python' &&
        interpreter !== 'dotnet' &&
        interpreter !== 'native'
      )
        throw invalidState(`${alias}.bins[${index}].interpreter is unknown`);
      const entry = bin.entry;
      if (entry !== undefined && typeof entry !== 'string')
        throw invalidState(`${alias}.bins[${index}].entry must be a string`);
      bins.push({
        name,
        path: binPath,
        shim,
        target,
        ...(!(interpreter === undefined) && { interpreter }),
        ...(!(entry === undefined) && { entry }),
      });
    }
    const installedAt = stringValue(record.installedAt, `${alias}.installedAt`);
    if (!Number.isFinite(Date.parse(installedAt)))
      throw invalidState(`${alias}.installedAt is not a timestamp`);
    if (
      record.lifecycleScriptsExecuted !== undefined &&
      typeof record.lifecycleScriptsExecuted !== 'boolean'
    )
      throw invalidState(`${alias}.lifecycleScriptsExecuted must be boolean`);
    const actualTreeDigest = await stableStoreTreeDigest(expectedStore);
    const treeDigest =
      record.treeDigest === undefined
        ? actualTreeDigest
        : stringValue(record.treeDigest, `${alias}.treeDigest`);
    if (!/^sha256:[0-9a-f]{64}$/u.test(treeDigest))
      throw invalidState(`${alias}.treeDigest must be a sha256 digest`);
    if (actualTreeDigest !== treeDigest)
      throw invalidState(`${alias}.treeDigest does not match its store tree`);
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
      treeDigest,
      storePath: expectedStore,
      bins,
      installedAt,
      ...(!(record.lifecycleScriptsExecuted === undefined) && {
        lifecycleScriptsExecuted: record.lifecycleScriptsExecuted,
      }),
      ...(!(record.sandboxBackend === undefined) && {
        sandboxBackend: record.sandboxBackend,
      }),
      ...(!(record.sandboxEnforced === undefined) && {
        sandboxEnforced: record.sandboxEnforced,
      }),
    };
  }
  return { schemaVersion: 1, packages: validated };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidState(`${name} must be an object`);
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    return await realpath(path);
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
        `Refusing network fetch for ${redactAddress(source)} while offline`,
      );
    }
    const response = await fetch(source, {
      ...(!(options.signal === undefined) && { signal: options.signal }),
    });
    if (!response.ok) {
      throw new OpmError(
        'FETCH_FAILED',
        `Failed to fetch ${redactAddress(source)}: HTTP ${response.status}`,
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
        `Artifact source is not a regular file: ${echoed(path, 1024)}`,
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
        `Artifact source changed while it was read: ${echoed(path, 1024)}`,
      );
    return bytes;
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpmError(
        'NOT_FOUND',
        `Artifact source not found: ${echoed(path, 1024)}`,
      );
    }
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new OpmError(
        'UNSAFE_SOURCE',
        `Artifact source must not be a symbolic link: ${echoed(path, 1024)}`,
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
  treeDigest: string;
}> {
  const pkg = input.pkg;
  const root = input.root;
  const offline = input.offline;
  const force = input.force === true;
  const callerBytes = input.bytes;
  const callerPolicy = input.policy;
  freezeBoundLockPackage(pkg);
  const suppliedBytes =
    callerBytes === undefined ? undefined : Uint8Array.from(callerBytes);
  const policy =
    callerPolicy === undefined
      ? undefined
      : immutablePlainData(callerPolicy, 'policy');
  const capability = verifiedArtifactFor(pkg);
  await assertLockPackageAllowed(pkg, policy, new Date().toISOString(), {
    registryArtifactVerified: capability?.provenance === 'registry',
    sourceVerified: manifestSourceVerified(pkg),
    ...(!(capability?.facts === undefined) && {
      verifiedFacts: capability.facts,
    }),
  });
  const paths = projectPaths(root);
  // Always derive store path from verified digest shape; never trust lock storeKey alone.
  assertStoreKey(pkg.storeKey, pkg.digest);
  const storePath = storePathForDigest(root, pkg.digest);
  const archivePath = `${storePath}.artifact`;
  await ensureStableDirectory(paths.opmDir);
  await ensureStableDirectory(paths.store);
  const storeHandle = await openStableDirectory(paths.store);
  try {
    const storeName = basename(storePath);
    const archiveName = basename(archivePath);
    let cached = false;
    let bytes = suppliedBytes ?? capability?.bytes;
    const loadVerifiedBytes = async (): Promise<Uint8Array> => {
      let loaded = bytes;
      if (loaded === undefined && !force) {
        try {
          loaded = await readStableFileBytesAt(
            storeHandle,
            archiveName,
            pkg.size + 1,
            archivePath,
          );
          cached = true;
        } catch (error) {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== 'ENOENT' &&
            !(error instanceof OpmError && error.code === 'NOT_FOUND')
          )
            throw error;
        }
      }
      if (
        loaded === undefined &&
        (pkg.source.startsWith('https:') || pkg.source.startsWith('http:'))
      )
        throw new OpmError(
          'UNVERIFIED_ARTIFACT',
          `Refusing to refetch ${echoed(pkg.purl)} outside its bounded provider transport`,
        );
      loaded ??= await fetchArtifactBytes(pkg.source, offline, {
        expectedBytes: pkg.size,
      });
      const actual = digestOf(loaded);
      if (actual !== pkg.digest) {
        throw new OpmError(
          'DIGEST_MISMATCH',
          `Digest mismatch for ${echoed(pkg.alias)}: expected ${echoed(pkg.digest)}, got ${actual}`,
        );
      }
      if (loaded.byteLength !== pkg.size) {
        throw new OpmError(
          'SIZE_MISMATCH',
          `Size mismatch for ${echoed(pkg.alias)}: expected ${pkg.size}, got ${loaded.byteLength}`,
        );
      }
      bytes = loaded;
      return loaded;
    };

    const stagedName = `.${basename(storePath)}.materialize-${randomUUID()}`;
    const stagedPath = join(paths.store, stagedName);

    let lifecycleScriptsExecuted = false;
    let sandboxOutcomes: SandboxOutcome[] = [];
    let treeDigest: string;
    let viaShared = false;
    let adoptedTreeDigest: string | undefined;
    try {
      // The user-level store, when one is on and usable for this project:
      // the files already exist there (or are put there once), and this
      // project's tree is links to them.
      const sharedRoot = await usableSharedRoot(stagedPath);
      if (sharedRoot !== undefined) {
        if (bytes !== undefined) await loadVerifiedBytes();
        const adopted = await materializeThroughSharedStore({
          digest: pkg.digest,
          projectStorePath: stagedPath,
          bytes: bytes !== undefined ? bytes : loadVerifiedBytes,
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          format: pkg.format as ArchiveFormat,
          sharedRoot,
        });
        viaShared = true;
        adoptedTreeDigest = adopted.treeDigest;
        // No byte moved: the shared entry was already there.
        if (bytes === undefined) cached = true;
      } else {
        bytes = await loadVerifiedBytes();
        const descriptor = await descriptorForBytes({
          bytes,
          descriptorId: pkg.storeKey,
          mediaType: pkg.mediaType,
          artifactType: 'package',
          nativeRole: 'native-package',
        });
        await materialize({
          source: bytesSource(bytes),
          descriptor,
          // materialize opens and holds its own stable parent authority. Passing
          // a /proc/self/fd path would make that walker traverse the procfs
          // symlink as though it were project data and can alias one of its own
          // new fds.
          destination: stagedPath,
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          format: pkg.format as ArchiveFormat,
        });
      }
      await revalidateStableDirectory(paths.store, storeHandle);

      // Lifecycle execution is confined to the unpublished quarantine tree.
      // A failed or partially contained build can never mutate the current CAS
      // entry that readers and generations already reference.
      if (pkg.ecosystem === 'npm') {
        const declared = await detectNpmLifecycleScripts(stagedPath);
        if (
          hasLifecycleScripts(declared) &&
          lifecycleScriptsAllowed(policy, pkg.purl)
        ) {
          if (viaShared) await isolateProjectStoreFromSharedLinks(stagedPath);
          const packageHandle = await openChild(
            storeHandle,
            stagedName,
            constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            const result = await runDeclaredLifecycleScripts({
              declared,
              packageDir: stagedPath,
              packageId: pkg.purl,
              policy,
              directoryAuthority: { fd: packageHandle.fd, path: stagedPath },
            });
            lifecycleScriptsExecuted = result.executed;
            sandboxOutcomes = result.outcomes;
          } finally {
            await packageHandle.close();
          }
        }
      }
      // A tree just linked from a verified shared entry, and not touched since,
      // already has its digest; anything else is hashed.
      treeDigest =
        adoptedTreeDigest !== undefined && !lifecycleScriptsExecuted
          ? adoptedTreeDigest
          : await stableStoreTreeDigest(stagedPath);
      await revalidateStableDirectory(paths.store, storeHandle);

      const backupName = `.${basename(storePath)}.replace-${randomUUID()}`;
      let backedUp = false;
      try {
        await renameChild(storeHandle, storeName, backupName);
        backedUp = true;
      } catch (error) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await renameChild(storeHandle, stagedName, storeName);
      } catch (error) {
        if (backedUp) await renameChild(storeHandle, backupName, storeName);
        throw error;
      }
      try {
        const publishedTreeDigest = await stableStoreTreeDigest(storePath);
        if (publishedTreeDigest !== treeDigest)
          throw new OpmError(
            'INPUT_CHANGED',
            `Post-build tree for ${echoed(pkg.purl)} changed during publication`,
          );
      } catch (error) {
        await removeChild(storeHandle, storeName, {
          recursive: true,
          force: true,
        });
        if (backedUp) await renameChild(storeHandle, backupName, storeName);
        throw error;
      }
      if (backedUp)
        await removeChild(storeHandle, backupName, {
          recursive: true,
          force: true,
        });
    } catch (error) {
      await revalidateStableDirectory(paths.store, storeHandle);
      throw error;
    } finally {
      await removeChild(storeHandle, stagedName, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    await revalidateStableDirectory(paths.store, storeHandle);
    // The tarball is kept only where the tree is not: a project that adopted
    // its files from the shared store has no second copy of them to maintain.
    if (bytes !== undefined && (!cached || force) && !viaShared)
      await writeStableFileAt(
        storeHandle,
        basename(archivePath),
        bytes,
        0o444,
        archivePath,
      );

    const bins: BinDeclaration[] =
      pkg.bins.length > 0
        ? [...pkg.bins]
        : await discoverBins(storePath, pkg.ecosystem);
    await revalidateStableDirectory(paths.store, storeHandle);
    return {
      storePath,
      bins,
      cached,
      lifecycleScriptsExecuted,
      sandboxOutcomes,
      treeDigest,
    };
  } finally {
    await storeHandle.close();
  }
}

/**
 * Replay a committed lockfile into the project store, bins, and links.
 *
 * TRUST ASSUMPTION: this function does not bind the lock to any manifest. The
 * caller must already have verified that the lock was produced from the
 * current manifest and policy — `installProject` enforces that binding one
 * level up (`assertLockMatchesManifest`: manifest digest plus direct
 * requirement closure, and a fresh re-resolution comparison in the online
 * path). Anyone replaying a lock from another source must establish the same
 * binding, or pass `expectedManifestDigest` so a lock that carries a
 * `manifestDigest` is checked against it before anything is installed.
 */
export async function installFromLock(input: {
  root: string;
  lock: OpmLockfile;
  offline: boolean;
  only?: readonly string[];
  policy?: PolicyInput;
  expectedManifestDigest?: string;
}): Promise<ProjectState> {
  const root = input.root;
  const offline = input.offline;
  const lock = input.lock;
  if (
    input.expectedManifestDigest !== undefined &&
    lock.manifestDigest !== undefined &&
    lock.manifestDigest !== input.expectedManifestDigest
  )
    throw new OpmError(
      'INVALID_LOCK',
      'Lock manifest digest does not match the caller-supplied manifest digest',
    );
  const lockPackages = lock.packages;
  const callerOnly = input.only;
  const only = callerOnly === undefined ? undefined : [...callerOnly];
  const callerPolicy = input.policy;
  const aliases = [
    ...(only ?? Object.keys(lockPackages).sort((a, b) => a.localeCompare(b))),
  ];
  const selectedPackages = new Map<string, LockPackage>();
  for (const alias of aliases) {
    const pkg = lockPackages[alias];
    if (!pkg)
      throw new OpmError(
        'NOT_FOUND',
        `Lock entry missing for ${echoed(alias)}`,
      );
    freezeBoundLockPackage(pkg);
    selectedPackages.set(alias, pkg);
  }
  const policy =
    callerPolicy === undefined
      ? undefined
      : immutablePlainData(callerPolicy, 'policy');
  const paths = projectPaths(root);
  await ensureStableDirectory(paths.opmDir);
  await ensureStableDirectory(paths.bin);
  await ensureStableDirectory(paths.links);

  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };

  // Evaluate the complete closure before the first package can fetch or
  // mutate disk. A denied transitive entry must not leave earlier packages
  // partially installed.
  const evaluationTime = new Date().toISOString();
  for (const alias of aliases) {
    const pkg = selectedPackages.get(alias);
    if (!pkg)
      throw new OpmError(
        'NOT_FOUND',
        `Lock entry missing for ${echoed(alias)}`,
      );
    const capability = verifiedArtifactFor(pkg);
    await assertLockPackageAllowed(pkg, policy, evaluationTime, {
      registryArtifactVerified: capability?.provenance === 'registry',
      sourceVerified: manifestSourceVerified(pkg),
      ...(!(capability?.facts === undefined) && {
        verifiedFacts: capability.facts,
      }),
    });
  }

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
      treeDigest: string;
    }
  >();
  for (const alias of aliases) {
    const safeAlias = assertSafeSegment(alias, 'package alias');
    const pkg = selectedPackages.get(alias);
    if (!pkg) {
      throw new OpmError(
        'NOT_FOUND',
        `Lock entry missing for ${echoed(alias)}`,
      );
    }
    const {
      storePath,
      bins,
      lifecycleScriptsExecuted,
      sandboxOutcomes,
      treeDigest,
    } = await materializeLockPackage({
      root,
      pkg,
      offline,
      ...(!(policy === undefined) && { policy }),
    });
    materialised.set(safeAlias, {
      storePath,
      bins,
      pkg,
      lifecycleScriptsExecuted,
      sandboxOutcomes,
      treeDigest,
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
      treeDigest,
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
      ...(pkg.ecosystem === 'pypi' && { pythonPath: pythonStoreRoots }),
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
      treeDigest,
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
    root,
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
      ...(!(policy === undefined) && { policy }),
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
  const policy =
    input.policy === undefined
      ? undefined
      : immutablePlainData(input.policy, 'policy');
  const digest = await digestSandboxPolicy(sandboxPolicyFromProject(policy));
  const backends = [
    ...new Set(input.outcomes.map((outcome) => outcome.backend)),
  ].sort();
  return {
    policyDigest: `${digest.algorithm}:${digest.value}`,
    lifecycleScriptsExecuted: input.lifecycleScriptsExecuted,
    ...(backends.length > 0 && { backends }),
    ...(input.lifecycleScriptsExecuted && {
      enforced:
        input.outcomes.length > 0 &&
        input.outcomes.every((outcome) => outcome.enforced),
    }),
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
  const alias = input.alias;
  const purl = input.purl;
  const version = input.version;
  const ecosystem = input.ecosystem;
  const bytes = Uint8Array.from(input.bytes);
  const source = input.source;
  const format = input.format;
  const mediaType = input.mediaType;
  const callerBins = input.bins;
  const bins =
    callerBins === undefined
      ? []
      : immutablePlainData(callerBins, 'bins').map((bin) => ({ ...bin }));
  const reason = input.reason ?? 'direct';
  const digest = digestOf(bytes);
  const pkg: LockPackage = {
    alias,
    purl,
    version,
    digest,
    size: bytes.byteLength,
    format,
    mediaType,
    source,
    storeKey: storeKeyFromDigest(digest),
    bins,
    reason,
    ecosystem,
  };
  const facts = captureFactsFromSourceUri(pkg.purl, pkg.source, {
    evaluationTime: new Date().toISOString(),
    dependencyDepth: pkg.reason === 'transitive' ? 1 : 0,
  });
  bindVerifiedArtifactBytes(pkg, bytes, 'direct', facts);
  sealVerifiedArtifactBinding(pkg);
  return pkg;
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
