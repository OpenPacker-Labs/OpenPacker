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
 *  1. read the lock (against the workspace the project's files declare), and
 *     refuse what it holds that cannot be installed;
 *  2. judge every package against the project's policy, before any fetch;
 *  3. take each archive from the shared store when it is there (found by the
 *     digest the lock pins) and otherwise fetch it from the lock's own URL,
 *     check it against that digest, and keep it; a package the lock patches
 *     is a patched copy of its archive, kept as an entry of its own;
 *  4. replace `node_modules` with the lock's layout, hard-linked from the store;
 *     in a workspace, each member is linked from its name rather than fetched,
 *     and has a `node_modules` of its own for the versions only it wants.
 *
 * Nothing is executed. A package that declares an install script is reported
 * and left as it is.
 */

import { join } from 'node:path';
import type {
  FrozenLockPackage,
  FrozenLockPeers,
  FrozenLockSkip,
  NativeLockEntry,
  NativeTarget,
  ProjectionResult,
} from '@openpacker/adapter-core';
import { removeBelow, removeTree } from '@openpacker/project-io';
import {
  adapterFailure,
  now,
  prepareFrozen,
  type FrozenInstallInput,
} from './frozen-prepare.js';
import { checkArchiveIdentities } from './frozen-identity.js';
import { patchArchives } from './frozen-patch.js';
import { installScriptFlags, scriptedPackages } from './frozen-scripts.js';
import { layOutFromStore } from './frozen-layout.js';
import { runApprovedBuilds, type BuiltPackage } from './frozen-builds.js';
import { projectStep } from './project-step.js';
import { OpmError } from './types.js';
import {
  frozenArchiveLimits,
  labelOf,
  openStore,
  storeArchives,
} from './frozen-store.js';
import {
  holdSharedStore,
  type HoldOptions,
  type StoreHold,
} from './shared-store-lease.js';

export type { FrozenInstallInput };

/**
 * Points inside an install where a test runs what may happen meanwhile, such
 * as a concurrent `opm gc --shared`. Not part of the package's API: only
 * `installFrozenWith` takes them, and `index.ts` does not export it.
 */
export interface FrozenInstallSeams {
  /** Once every archive is in the store, before any is linked into `node_modules`. */
  beforeLayout?: () => Promise<void>;
  /** How the install's hold on the shared store waits, and where it steps. */
  hold?: HoldOptions;
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
  /** The machines the install was for, when that is more than this one. */
  targets?: readonly NativeTarget[];
  /** Packages patched (store entries made or found), and the patches that did it. */
  patched: { packages: number; patches: number };
  /** Installed packages that declare an install script. None was run. */
  installScripts: readonly { name: string; version: string; path: string }[];
  /** The packages whose approved install scripts ran, in place (ADR 0060). */
  built: readonly BuiltPackage[];
  /** For a workspace lock: the members the lock holds, and the ones linked here. */
  workspace?: { members: number; linked: number };
  /** Present when the places do not keep every shared peer to one copy of it. */
  peers?: FrozenLockPeers;
  layout: ProjectionResult;
  milliseconds: { read: number; fetch: number; layout: number; total: number };
}

export function installFrozen(
  input: FrozenInstallInput,
): Promise<FrozenInstallResult> {
  return installFrozenWith(input, {});
}

/** `installFrozen` with the seams a test runs inside it. */
export async function installFrozenWith(
  input: FrozenInstallInput,
  seams: FrozenInstallSeams,
): Promise<FrozenInstallResult> {
  return projectStep(input.root, input.step, () =>
    installFrozenInStep(input, seams),
  );
}

async function installFrozenInStep(
  input: FrozenInstallInput,
  seams: FrozenInstallSeams,
): Promise<FrozenInstallResult> {
  const first = await prepareFrozen(input);
  const { started, root, env, ecosystem, format, detected, offline } = first;
  let { read, lock, claims } = first;

  const store = await openStore(root, env);
  let hold: StoreHold | undefined;
  try {
    // Every entry is claimed before it is looked up, and the claims last until
    // node_modules links them, so `opm gc --shared` cannot take one between
    // (ADR 0048, amendment 2026-10-17).
    if (store.shared)
      hold = await holdSharedStore(store.root, {
        ...seams.hold,
        ...(input.signal !== undefined && { signal: input.signal }),
      });
    const from = {
      claims,
      storeRoot: store.root,
      shared: store.shared,
      limits: frozenArchiveLimits(lock.extraction),
      offline,
      ecosystem,
      options: input,
      ...(hold !== undefined && { hold }),
    };
    // A package whose lock entry leaves its C library unsaid is decided by
    // what its archive declares, before anything else is fetched: one that
    // does not run here is never extracted (`frozen-archive-platform.ts`).
    const marked = lock.packages.filter((pkg) => pkg.platformFromArchive);
    const early =
      marked.length === 0 || lock.archiveRuns === undefined
        ? undefined
        : await storeArchives({
            lock: { ...lock, packages: marked },
            ...from,
            runs: lock.archiveRuns,
          });
    if (early !== undefined && early.platforms.size > 0) {
      const again = await prepareFrozen(input, early.platforms);
      if (again.lock.lockDigest !== lock.lockDigest)
        throw new OpmError(
          'INPUT_CHANGED',
          `${lock.lockPath} changed while it was installed; nothing was installed from it`,
        );
      ({ read, lock, claims } = again);
      from.claims = claims;
    }
    const stored = await storeArchives({ lock, ...from });
    if (early !== undefined) {
      // An archive fetched to read its lists is fetched, whichever pass keeps
      // it: the second pass finds it in the store.
      const fetchedEarly = new Set(
        [...early.byPath.values()]
          .filter((item) => item.fetched && item.leftOut !== true)
          .map((item) => item.digest),
      );
      const counted = new Set<string>();
      for (const item of stored.byPath.values()) {
        if (item.fetched || counted.has(item.digest)) continue;
        counted.add(item.digest);
        if (!fetchedEarly.has(item.digest)) continue;
        stored.fetched += 1;
        stored.fromStore -= 1;
      }
      stored.fetchedBytes += early.fetchedBytes;
    }
    const fetched = now();
    // The archives are proved to be the lock's packages before any is patched,
    // and what declares a script is read from what is installed: the patched
    // files, where there is a patch (ADR 0057).
    await checkArchiveIdentities(lock.packages, stored.byPath);
    const patching = {
      storeRoot: store.root,
      shared: store.shared,
      format,
      ...(hold !== undefined && { hold }),
    };
    const { byPath, patched } = await patchArchives({
      lock,
      byPath: stored.byPath,
      ...patching,
    });
    const declares = await installScriptFlags(lock.packages, byPath);
    const entries = lock.packages.map((pkg): NativeLockEntry => {
      const archive = byPath.get(pkg.path)!;
      return {
        purl: pkg.purl,
        // The package's own name, as a resolved closure's entry has; the
        // directory it lives under is `layoutPath`, and for an aliased
        // dependency (`"string-width-cjs": "npm:string-width@^4"`) that name
        // is the install name.
        name: pkg.packageName,
        ...(pkg.name !== pkg.packageName && { installName: pkg.name }),
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
    // `npm ci` clears every workspace's `node_modules`, whichever it installs,
    // and so does this; a member's directory comes from the lock, so each is
    // reached from the project root without following a link.
    for (const dir of lock.workspace?.memberDirs ?? [])
      await removeBelow(root, `${dir}/node_modules`);
    await removeTree(join(root, 'node_modules'));
    await seams.beforeLayout?.();
    const write = async (): Promise<ProjectionResult> => {
      try {
        return await format.writeLayout!(
          detected,
          entries,
          lock.workspace === undefined
            ? undefined
            : { workspace: lock.workspace.layout },
        );
      } catch (error) {
        throw adapterFailure(error);
      }
    };
    // What node_modules links from: the patched copy, where there is a patch.
    const pathOf = (pkg: FrozenLockPackage) => byPath.get(pkg.path)!.path;
    const layout = !store.shared
      ? await write()
      : await layOutFromStore({
          sources: lock.packages.map((pkg) => ({
            storePath: pathOf(pkg),
            label: labelOf(pkg),
          })),
          write,
          restore: async (gone) => {
            const packages = lock.packages.filter((pkg) =>
              gone.has(pathOf(pkg)),
            );
            const again = await storeArchives({
              lock: { ...lock, packages },
              ...from,
            });
            stored.fetched += again.fetched;
            stored.fetchedBytes += again.fetchedBytes;
            // A patched copy is made again, at its own key, from the archive
            // put back (ADR 0057).
            await patchArchives({
              lock: { packages },
              byPath: again.byPath,
              ...patching,
            });
          },
        });
    // The install scripts the project approved, in place, now that every
    // package they may need is laid out (ADR 0060).
    const built = await runApprovedBuilds({ root, lock, declares });
    const ran = new Set(built.map((item) => item.path));
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
      ...(lock.targets !== undefined && { targets: lock.targets }),
      ...(lock.peers !== undefined && { peers: lock.peers }),
      installScripts: scriptedPackages(lock.packages, declares, byPath).filter(
        (item) => !ran.has(item.path),
      ),
      built,
      patched,
      layout,
      ...(lock.workspace !== undefined && {
        workspace: {
          members: lock.workspace.memberDirs.length,
          // The links in the project's own node_modules; a member's own
          // links (pnpm's place for its `link:` dependencies) are not counted.
          linked: lock.workspace.layout.links.filter((link) =>
            link.path.startsWith('node_modules/'),
          ).length,
        },
      }),
      milliseconds: {
        read: read - started,
        fetch: fetched - read,
        layout: done - fetched,
        total: done - started,
      },
    };
  } finally {
    await hold?.release();
    await store.dispose();
  }
}
