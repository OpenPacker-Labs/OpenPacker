/**
 * Install exactly what a lock says.
 *
 * `opm ci` reads a committed lock (npm's `package-lock.json`), fetches or finds
 * each archive it pins, proves the bytes are the ones pinned, and writes the
 * tree the lock describes. It resolves nothing: a package the lock does not
 * name is not installed, one it names is installed at the version and place it
 * names, and a lock that cannot be honoured as written is refused whole.
 *
 * The lock is read by the ecosystem's adapter (`ProjectFormat.readFrozenLock`);
 * what is generic is here. In order:
 *
 *  1. read the lock, and refuse what it holds that cannot be installed;
 *  2. judge every package against the project's policy, before any fetch;
 *  3. take each archive from the shared store when it is there (found by the
 *     digest the lock pins) and otherwise fetch it from the lock's own URL,
 *     check it against that digest, and keep it;
 *  4. replace `node_modules` with the lock's layout, hard-linked from the store.
 *
 * Nothing is executed. A package that declares an install script is reported
 * and left as it is.
 */

import { randomUUID, createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  detectNativeTarget,
  redactUrl,
  type DetectedProject,
  type FrozenLock,
  type FrozenLockPackage,
  type FrozenLockSkip,
  type FrozenOmit,
  type NativeLockEntry,
  type NativeTarget,
  type ProjectFormat,
  type ProjectionResult,
} from '@openpacker/adapter-core';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from '@openpacker/materializer';
import { removeTree } from '@openpacker/project-io';
import { requireAdapterRegistry } from './adapters.js';
import {
  downloadArchive,
  mapPool,
  MAXIMUM_ARCHIVE_BYTES,
  MemoryBudget,
  transportForSources,
  type FrozenFetchOptions,
} from './frozen-fetch.js';
import {
  assertFrozenAllowed,
  frozenPolicyDocument,
  listLines,
} from './frozen-policy.js';
import { inferFormat } from './install.js';
import {
  checkIntegrity,
  integrityKey,
  strongestClaims,
  type IntegrityClaim,
} from './integrity.js';
import {
  ensureStableDirectory,
  MANIFEST_NAME,
  projectPaths,
  removeStableTree,
} from './paths.js';
import { readManifestFile } from './project.js';
import {
  adoptSharedEntry,
  publishSharedEntry,
  usableSharedRoot,
} from './shared-store.js';
import {
  lookupArchiveDigest,
  recordArchiveDigest,
} from './shared-store-index.js';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';

export interface FrozenInstallInput extends FrozenFetchOptions {
  /** The project directory: where the manifest, the lock and `node_modules` are. */
  root: string;
  /** Which ecosystem's lock, when a project holds more than one. */
  ecosystem?: string;
  /** Kinds of dependency to leave out: `dev` for a production install. */
  omit?: Iterable<FrozenOmit>;
  /** Fetch nothing. Defaults to the project's `[options] offline`. */
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The machine to install for; this one by default. */
  target?: NativeTarget;
  /** The time policy is evaluated at. */
  now?: () => string;
  /** Archives read at the same time. */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface FrozenInstallResult {
  ecosystem: string;
  lockPath: string;
  /** sha256 over the lock file's bytes. */
  lockDigest: string;
  /** Packages written. */
  installed: number;
  /** Archives found in the store, and archives fetched (once each). */
  fromStore: number;
  fetched: number;
  fetchedBytes: number;
  /** True when archives came from, and were kept in, the shared store. */
  shared: boolean;
  /** What the lock holds that this machine and these options leave out. */
  skipped: readonly FrozenLockSkip[];
  /** Installed packages that declare an install script. None was run. */
  installScripts: readonly { name: string; version: string; path: string }[];
  layout: ProjectionResult;
  milliseconds: { read: number; fetch: number; layout: number; total: number };
}

/** An archive in a store, and where it came from this time. */
interface Stored {
  path: string;
  digest: string;
  /** Bytes fetched for it this time; 0 when the store already had it. */
  fetchedBytes: number;
  fetched: boolean;
}

const DEFAULT_CONCURRENCY = 8;

/**
 * Bounds an archive is extracted under. They are larger than the materializer's
 * defaults, which suit a small tool and not a dependency tree (a native build
 * of onnxruntime is 287 MB unpacked, some packages ship tens of thousands of
 * files), and no larger than a tree opm can then hash and link.
 */
export function frozenArchiveLimits(extraction: {
  acceptRedundantEntries: boolean;
}): MaterializationLimits {
  return {
    ...DEFAULT_MATERIALIZATION_LIMITS,
    maximumFiles: 100_000,
    maximumExpandedBytes: 1024 * 1024 * 1024,
    maximumCompressedBytes: MAXIMUM_ARCHIVE_BYTES,
    maximumCompressionRatio: 128,
    maximumMemoryBytes: 3 * 1024 * 1024 * 1024,
    ...(extraction.acceptRedundantEntries && { acceptRedundantEntries: true }),
  };
}

/** Memory extraction may hold across all archives at once. */
const EXTRACTION_MEMORY = 2 * 1024 * 1024 * 1024;
/** What extracting an archive is expected to hold, per byte of the archive. */
const EXTRACTION_FOOTPRINT = 8;

function now(): number {
  return performance.now();
}

/** The ecosystem project in `root` whose adapter can read its lock. */
async function findFrozenProject(
  root: string,
  wanted: string | undefined,
): Promise<{
  ecosystem: string;
  format: ProjectFormat;
  detected: DetectedProject;
}> {
  const registry = requireAdapterRegistry();
  const found: {
    ecosystem: string;
    format: ProjectFormat;
    detected: DetectedProject;
  }[] = [];
  const seen = new Set<string>();
  for (const type of registry.purlTypes()) {
    if (wanted !== undefined && type !== wanted.toLowerCase()) continue;
    const format = await registry.projectFormatFor(type).catch(() => undefined);
    if (format === undefined || seen.has(format.providerId)) continue;
    seen.add(format.providerId);
    if (format.readFrozenLock === undefined || format.writeLayout === undefined)
      continue;
    if (!(await registry.projectionLevels(type)).layout) continue;
    const detected = await format.detect(root);
    if (detected !== undefined)
      found.push({ ecosystem: format.purlType, format, detected });
  }
  if (found.length === 1) return found[0]!;
  if (found.length === 0)
    throw new OpmError(
      'NOT_FOUND',
      `No project in ${root} has a lock opm can install exactly. It needs a package.json and a package-lock.json side by side`,
    );
  throw new OpmError(
    'AMBIGUOUS_SPEC',
    `${root} holds locks for more than one ecosystem (${found.map((item) => item.ecosystem).join(', ')}); name one`,
  );
}

async function readProjectManifest(
  root: string,
): Promise<OpmManifest | undefined> {
  try {
    await access(join(root, MANIFEST_NAME));
  } catch {
    return undefined;
  }
  return readManifestFile(projectPaths(root).manifest);
}

/** Errors the adapter throws in its own vocabulary, in opm's. */
function adapterFailure(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error instanceof OpmError) return error;
  const codes: Record<string, string> = {
    INVALID_LOCKFILE: 'INVALID_LOCK',
    INVALID_MANIFEST: 'INVALID_MANIFEST',
    NOT_FOUND: 'NOT_FOUND',
    UNSAFE_PATH: 'UNSAFE_PATH',
    LAYOUT_PATHS_INVALID: 'INVALID_LOCK',
    LAYOUT_TOO_LARGE: 'SIZE_LIMIT',
  };
  // SAFETY: provider errors carry an optional string `code`.
  const code = (error as { code?: unknown }).code;
  const mapped = typeof code === 'string' ? codes[code] : undefined;
  return mapped === undefined
    ? error
    : new OpmError(mapped, error.message, { cause: error });
}

/** Where archives are extracted: the shared store, else a private scratch one. */
async function openStore(root: string, env: NodeJS.ProcessEnv) {
  const shared = await usableSharedRoot(root, env);
  if (shared !== undefined)
    return {
      root: shared,
      shared: true,
      dispose: async (): Promise<void> => undefined,
    };
  // A project that does not share (or whose shared store is on another disk)
  // extracts beside `node_modules`, so the files can be linked into it, and
  // deletes the extraction afterwards: the links keep the files.
  const scratch = join(root, `.opm-ci-${randomUUID()}`);
  await ensureStableDirectory(scratch);
  return {
    root: scratch,
    shared: false,
    dispose: async (): Promise<void> => {
      await removeStableTree(scratch).catch(() => undefined);
    },
  };
}

function labelOf(pkg: FrozenLockPackage): string {
  return `${pkg.packageName}@${pkg.version} (${pkg.path})`;
}

export async function installFrozen(
  input: FrozenInstallInput,
): Promise<FrozenInstallResult> {
  const started = now();
  const root = resolve(input.root);
  const env = input.env ?? process.env;
  const { ecosystem, format, detected } = await findFrozenProject(
    root,
    input.ecosystem,
  );
  const manifest = await readProjectManifest(root);
  const offline = input.offline ?? manifest?.options.offline ?? false;

  let lock: FrozenLock;
  try {
    lock = await format.readFrozenLock!(detected, {
      target: input.target ?? detectNativeTarget(),
      omit: new Set(input.omit ?? []),
    });
  } catch (error) {
    throw adapterFailure(error);
  }
  if (lock.refused.length > 0)
    throw new OpmError(
      'UNSUPPORTED_LOCK',
      `Refusing to install ${lock.lockPath}: it holds ${lock.refused.length} entr${lock.refused.length === 1 ? 'y' : 'ies'} opm ci cannot install, and installing the rest would not be installing the lock:\n${listLines(lock.refused.map((item) => `${item.path}: ${item.reason}`))}`,
    );

  const evaluationTime = (input.now ?? (() => new Date().toISOString()))();
  await assertFrozenAllowed(
    frozenPolicyDocument(manifest?.policy),
    lock.packages,
    ecosystem,
    evaluationTime,
  );
  const unfetchable = lock.packages.filter(
    (pkg) => pkg.sourceKind === 'git' || pkg.sourceKind === 'path',
  );
  if (unfetchable.length > 0)
    throw new OpmError(
      'UNSUPPORTED_LOCK',
      `opm ci installs from archives with a pinned digest, and cannot install ${unfetchable.length} package${unfetchable.length === 1 ? '' : 's'} from a git or path source yet:\n${listLines(unfetchable.map((pkg) => `${labelOf(pkg)}: ${redactSource(pkg.source)}`))}`,
    );
  const claims = new Map<string, IntegrityClaim[]>(
    lock.packages.map((pkg) => [
      pkg.path,
      strongestClaims(pkg.integrity, labelOf(pkg)),
    ]),
  );
  const read = now();

  const store = await openStore(root, env);
  try {
    const stored = await storeArchives({
      lock,
      claims,
      storeRoot: store.root,
      shared: store.shared,
      limits: frozenArchiveLimits(lock.extraction),
      offline,
      ecosystem,
      options: input,
    });
    const fetched = now();
    const entries = lock.packages.map((pkg): NativeLockEntry => {
      const archive = stored.byPath.get(pkg.path)!;
      return {
        purl: pkg.purl,
        name: pkg.name,
        scope: pkg.scope,
        exactPurl: pkg.exactPurl,
        version: pkg.version,
        source: pkg.source,
        digest: archive.digest,
        size: archive.fetchedBytes,
        storePath: archive.path,
        transitive: !pkg.direct,
        layoutPath: pkg.path,
      };
    });
    // The lock is the whole tree: whatever was there before is not part of it.
    await removeTree(join(root, 'node_modules'));
    let layout: ProjectionResult;
    try {
      layout = await format.writeLayout!(detected, entries);
    } catch (error) {
      throw adapterFailure(error);
    }
    const done = now();
    return {
      ecosystem,
      lockPath: lock.lockPath,
      lockDigest: lock.lockDigest,
      installed: lock.packages.length,
      fromStore: stored.fromStore,
      fetched: stored.fetched,
      fetchedBytes: stored.fetchedBytes,
      shared: store.shared,
      skipped: lock.skipped,
      installScripts: lock.packages
        .filter((pkg) => pkg.hasInstallScript)
        .map((pkg) => ({
          name: pkg.packageName,
          version: pkg.version,
          path: pkg.path,
        })),
      layout,
      milliseconds: {
        read: read - started,
        fetch: fetched - read,
        layout: done - fetched,
        total: done - started,
      },
    };
  } finally {
    await store.dispose();
  }
}

function redactSource(source: string): string {
  try {
    return redactUrl(new URL(source));
  } catch {
    return source.replace(/\/\/[^/@]*@/u, '//');
  }
}

/**
 * Put every archive the lock pins in the store and say where.
 *
 * One archive is handled once however many places the lock puts it. The store
 * is asked first, by the digest the lock pins; what is not there is fetched,
 * proved against that digest, and only then kept.
 */
async function storeArchives(input: {
  lock: FrozenLock;
  claims: ReadonlyMap<string, readonly IntegrityClaim[]>;
  storeRoot: string;
  shared: boolean;
  limits: MaterializationLimits;
  offline: boolean;
  ecosystem: string;
  options: FrozenInstallInput;
}) {
  const { lock, claims, storeRoot } = input;
  const memory = new MemoryBudget(EXTRACTION_MEMORY);
  const keyOf = (pkg: FrozenLockPackage) => integrityKey(claims.get(pkg.path)!);
  const firsts = new Map<string, FrozenLockPackage>();
  for (const pkg of lock.packages)
    if (!firsts.has(keyOf(pkg))) firsts.set(keyOf(pkg), pkg);
  const transport = input.offline
    ? undefined
    : transportForSources(
        input.ecosystem,
        [...firsts.values()].map((pkg) => pkg.source),
        input.options,
      );

  const missing: string[] = [];
  const results = await mapPool(
    [...firsts.entries()],
    input.options.concurrency ?? DEFAULT_CONCURRENCY,
    async ([key, pkg]): Promise<Stored | undefined> => {
      if (input.shared) {
        const known = await lookupArchiveDigest(storeRoot, key);
        const entry =
          known === undefined
            ? undefined
            : await adoptSharedEntry(storeRoot, known);
        if (known !== undefined && entry !== undefined)
          return {
            path: entry.path,
            digest: known,
            fetchedBytes: 0,
            fetched: false,
          };
      }
      if (transport === undefined) {
        missing.push(labelOf(pkg));
        return undefined;
      }
      const bytes = await downloadArchive(
        transport,
        pkg.source,
        labelOf(pkg),
        input.options.signal,
      );
      const checked = checkIntegrity(bytes, claims.get(pkg.path)!);
      if (!checked.ok)
        throw new OpmError(
          'DIGEST_MISMATCH',
          `${labelOf(pkg)} does not match the integrity the lock pins: the lock says ${pkg.integrity}, ${redactSource(pkg.source)} served ${checked.actual}. Nothing was installed from it`,
        );
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const entry = await memory
        .hold(bytes.byteLength * EXTRACTION_FOOTPRINT, async () =>
          publishSharedEntry({
            sharedRoot: storeRoot,
            digest,
            format: inferFormat(pkg.source),
            bytes,
            seal: input.shared,
            limits: input.limits,
          }),
        )
        .catch((error: unknown) => {
          // The materializer refuses an unsafe archive in its own words; say whose.
          throw error instanceof OpmError
            ? error
            : new OpmError(
                'UNSAFE_PATH',
                `${labelOf(pkg)} cannot be extracted: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
        });
      if (input.shared) await recordArchiveDigest(storeRoot, key, digest);
      return {
        path: entry.path,
        digest,
        fetchedBytes: bytes.byteLength,
        fetched: true,
      };
    },
  );
  missing.sort();
  if (missing.length > 0)
    throw new OpmError(
      'OFFLINE',
      `${missing.length} package${missing.length === 1 ? ' is' : 's are'} not in the local store and opm ci is offline:\n${listLines(missing)}`,
    );
  const byKey = new Map(
    [...firsts.keys()].map((key, index) => [key, results[index]!]),
  );
  const byPath = new Map(
    lock.packages.map((pkg) => [pkg.path, byKey.get(keyOf(pkg))!]),
  );
  const archives = [...byKey.values()];
  return {
    byPath,
    fromStore: archives.filter((item) => !item.fetched).length,
    fetched: archives.filter((item) => item.fetched).length,
    fetchedBytes: archives.reduce((sum, item) => sum + item.fetchedBytes, 0),
  };
}
