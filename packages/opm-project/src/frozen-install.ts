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
 *     check it against that digest, and keep it;
 *  4. replace `node_modules` with the lock's layout, hard-linked from the store;
 *     in a workspace, each member is linked from its name rather than fetched,
 *     and has a `node_modules` of its own for the versions only it wants.
 *
 * Nothing is executed. A package that declares an install script is reported
 * and left as it is.
 */

import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  detectNativeTarget,
  echoed,
  echoedValue,
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
import { removeBelow, removeTree } from '@openpacker/project-io';
import { requireAdapterRegistry } from './adapters.js';
import { type FrozenFetchOptions } from './frozen-fetch.js';
import {
  assertFrozenAllowed,
  frozenPolicyDocument,
  listLines,
} from './frozen-policy.js';
import {
  frozenArchiveLimits,
  labelOf,
  openStore,
  redactSource,
  storeArchives,
} from './frozen-store.js';
import { layOutFromStore, type FrozenInstallSeams } from './frozen-layout.js';
import {
  prepareFrozenWorkspace,
  type FrozenWorkspaceRequest,
} from './frozen-workspace.js';
import { strongestClaims, type IntegrityClaim } from './integrity.js';
import { MANIFEST_NAME, projectPaths } from './paths.js';
import { readManifestFile } from './project.js';
import { projectStep, type StepOptions } from './project-step.js';
import { holdSharedStore, type StoreHold } from './shared-store-lease.js';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';

export type { FrozenInstallSeams };

export interface FrozenInstallInput extends FrozenFetchOptions {
  /** The project directory: where the manifest, the lock and `node_modules` are. */
  root: string;
  /** Which ecosystem's lock, when a project holds more than one. */
  ecosystem?: string;
  /** Kinds of dependency to leave out: `dev` for a production install. */
  omit?: Iterable<FrozenOmit>;
  /** Which part of a workspace to install (`-w`, `--include-workspace-root`, `--workspaces`). */
  workspace?: FrozenWorkspaceRequest;
  /** Fetch nothing. Defaults to the project's `[options] offline`. */
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The machine to install for; this one by default. */
  target?: NativeTarget;
  /** The time policy is evaluated at. */
  now?: () => string;
  /** Told what a killed step left and this one finished first. */
  step?: StepOptions;
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
  /** For a workspace lock: the members the lock holds, and the ones linked here. */
  workspace?: { members: number; linked: number };
  layout: ProjectionResult;
  milliseconds: { read: number; fetch: number; layout: number; total: number };
}

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
  const started = now();
  const root = resolve(input.root);
  const env = input.env ?? process.env;
  const { ecosystem, format, detected } = await findFrozenProject(
    root,
    input.ecosystem,
  );
  const manifest = await readProjectManifest(root);
  const offline = input.offline ?? manifest?.options.offline ?? false;

  const workspace = await prepareFrozenWorkspace(root, format, input.workspace);
  let lock: FrozenLock;
  try {
    lock = await format.readFrozenLock!(detected, {
      target: input.target ?? detectNativeTarget(),
      omit: new Set(input.omit ?? []),
      ...(workspace !== undefined && { workspace }),
    });
  } catch (error) {
    throw adapterFailure(error);
  }
  if (lock.refused.length > 0)
    throw new OpmError(
      'UNSUPPORTED_LOCK',
      `Refusing to install ${lock.lockPath}: it holds ${lock.refused.length} entr${lock.refused.length === 1 ? 'y' : 'ies'} opm ci cannot install, and installing the rest would not be installing the lock:\n${listLines(lock.refused.map((item) => `${echoedValue(item.path)}: ${echoed(item.reason)}`))}`,
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
      `opm ci installs from archives with a pinned digest, and cannot install ${unfetchable.length} package${unfetchable.length === 1 ? '' : 's'} from a git or path source yet:\n${listLines(unfetchable.map((pkg) => `${labelOf(pkg)}: ${echoed(redactSource(pkg.source))}`))}`,
    );
  const claims = new Map<string, IntegrityClaim[]>(
    lock.packages.map((pkg) => [
      pkg.path,
      strongestClaims(pkg.integrity, labelOf(pkg)),
    ]),
  );
  const read = now();

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
    const stored = await storeArchives({ lock, ...from });
    const fetched = now();
    const entries = lock.packages.map((pkg): NativeLockEntry => {
      const archive = stored.byPath.get(pkg.path)!;
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
    const pathOf = (pkg: FrozenLockPackage) =>
      stored.byPath.get(pkg.path)!.path;
    const layout = !store.shared
      ? await write()
      : await layOutFromStore({
          sources: lock.packages.map((pkg) => ({
            storePath: pathOf(pkg),
            label: labelOf(pkg),
          })),
          write,
          restore: async (gone) => {
            const again = await storeArchives({
              lock: {
                ...lock,
                packages: lock.packages.filter((pkg) => gone.has(pathOf(pkg))),
              },
              ...from,
            });
            stored.fetched += again.fetched;
            stored.fetchedBytes += again.fetchedBytes;
          },
        });
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
      ...(lock.workspace !== undefined && {
        workspace: {
          members: lock.workspace.memberDirs.length,
          linked: lock.workspace.layout.links.length,
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
