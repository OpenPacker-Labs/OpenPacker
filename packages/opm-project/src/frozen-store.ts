/**
 * Getting the archives a lock pins into a store.
 *
 * One archive is handled once however many places the lock puts it. The store
 * is asked first, by the digest the lock pins; what is not there is fetched,
 * proved against that digest, and only then kept. Where the store is, and how
 * much an extraction may hold in memory, are decided here.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  echoed,
  echoedValue,
  PACKAGE_TREE_LIMITS,
  redactAddress,
  type FrozenLock,
  type FrozenLockPackage,
} from '@openpacker/adapter-core';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from '@openpacker/materializer';
import {
  downloadArchive,
  mapPool,
  MAXIMUM_ARCHIVE_BYTES,
  MemoryBudget,
  transportForSources,
  type FrozenFetchOptions,
} from './frozen-fetch.js';
import { listLines } from './frozen-policy.js';
import { inferFormat } from './install.js';
import {
  checkIntegrity,
  integrityKey,
  type IntegrityClaim,
} from './integrity.js';
import {
  ensureStableDirectory,
  removeStableTree,
  storeKeyFromDigest,
} from './paths.js';
import {
  adoptSharedEntry,
  publishSharedEntry,
  usableSharedRoot,
} from './shared-store.js';
import {
  lookupArchiveDigest,
  recordArchiveDigest,
} from './shared-store-index.js';
import type { StoreHold } from './shared-store-lease.js';
import { OpmError } from './types.js';

/**
 * What the machine can refuse an extraction, whatever the archive holds: a
 * full or read-only disk, a store this user may not write, a failing device,
 * a process out of descriptors or memory. Any other failed system call is the
 * archive's doing (a name a file system will not hold, a path that is both a
 * file and a directory) and is an unsafe path.
 */
const ENVIRONMENTAL = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EACCES',
  'EPERM',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
]);

/** A failed system call that says something about the machine, not the archive. */
export function isEnvironmentalError(error: unknown): boolean {
  // SAFETY: only the two fields Node puts on a failed syscall are read.
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  return typeof syscall === 'string' && ENVIRONMENTAL.has(code ?? '');
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
 * files), and no larger than a tree opm can then hash and link. Files, depth
 * and path length are `PACKAGE_TREE_LIMITS`, which a pnpm patch's paths are
 * held to as well (ADR 0057).
 */
export function frozenArchiveLimits(extraction: {
  acceptRedundantEntries: boolean;
}): MaterializationLimits {
  return {
    ...DEFAULT_MATERIALIZATION_LIMITS,
    ...PACKAGE_TREE_LIMITS,
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

/** Where archives are extracted: the shared store, else a private scratch one. */
export async function openStore(root: string, env: NodeJS.ProcessEnv) {
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

export function labelOf(pkg: FrozenLockPackage): string {
  return `${echoedValue(pkg.packageName)}@${echoedValue(pkg.version)} (${echoedValue(pkg.path)})`;
}

/**
 * A lock entry's source as an error may show it (`redactAddress` in
 * `@openpacker/adapter-core`, which `classifyResolved` and the fetch plan use
 * for the same text): the scheme, and the host and path the URL parser read,
 * never userinfo, query or fragment, or the scheme and `[address withheld]` for
 * an address it refuses or one in which an `@` may end a password (with no
 * scheme where it may be a user name), or `[url]` for a host the URL parser
 * should not be given.
 */
export function redactSource(source: string): string {
  return redactAddress(source);
}

/**
 * Put every archive the lock pins in the store and say where.
 *
 * One archive is handled once however many places the lock puts it. The store
 * is asked first, by the digest the lock pins; what is not there is fetched,
 * proved against that digest, and only then kept.
 */
export async function storeArchives(input: {
  lock: FrozenLock;
  claims: ReadonlyMap<string, readonly IntegrityClaim[]>;
  storeRoot: string;
  shared: boolean;
  limits: MaterializationLimits;
  offline: boolean;
  ecosystem: string;
  options: FrozenFetchOptions & { concurrency?: number; signal?: AbortSignal };
  /** The install's hold on the shared store: each entry is claimed before use. */
  hold?: StoreHold;
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
        if (known !== undefined)
          await input.hold?.claim(storeKeyFromDigest(known));
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
          `${labelOf(pkg)} does not match the integrity the lock pins: the lock says ${echoed(pkg.integrity ?? '')}, ${echoed(redactSource(pkg.source))} served ${checked.actual}. Nothing was installed from it`,
        );
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      await input.hold?.claim(storeKeyFromDigest(digest));
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
          // The materializer refuses an unsafe archive in its own words; say
          // whose. The machine refusing the write (a read-only store, a full
          // disk) says so itself, and is not an unsafe archive.
          throw error instanceof OpmError || isEnvironmentalError(error)
            ? error
            : new OpmError(
                'UNSAFE_PATH',
                `${labelOf(pkg)} cannot be extracted: ${echoed(error instanceof Error ? error.message : String(error))}`,
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
