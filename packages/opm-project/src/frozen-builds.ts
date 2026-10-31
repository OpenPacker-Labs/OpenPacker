/**
 * The install scripts a project approved, run where npm runs them.
 *
 * `opm ci` runs no install script by default (ADR 0046 §9). A project that
 * needs one approves it by name in a declaration package managers already
 * read (the lock's `approvedBuilds`: pnpm's `onlyBuiltDependencies` and
 * `allowBuilds`, Bun's `trustedDependencies`), and only that package's
 * `preinstall`, `install` and `postinstall` run (ADR 0060):
 *
 * - in the package's own directory under `node_modules`, after the layout, so
 *   the script finds its dependencies the way it does under npm;
 * - with opm's `npm`, `pnpm` and `yarn` first on PATH when the caller hands
 *   them over (ADR 0061), so a script's `npm run build` runs its own `build`
 *   through `opm run`, in the same jail;
 * - inside the package-exec jail, with that directory writable, the project
 *   read-only and no network;
 * - on the package's own copies of its files: they are hard links into the
 *   shared store until then, and the store is never written through them;
 * - and a symbolic link the script leaves inside its directory, to a file of
 *   its own, becomes a hard link to that file (`node_modules` holds no symlink
 *   but a workspace member's, ADR 0048). Any other link fails the install.
 *
 * They run in dependency order (ADR 0060 §7, `frozen-build-order.ts`): a
 * package's after those of every approved package it depends on, the lock's
 * order where nothing says otherwise, and a cycle in the lock's order,
 * reported.
 */

import { constants } from 'node:fs';
import {
  link,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FrozenLock, FrozenLockPackage } from '@openpacker/adapter-core';
import type { PolicyInput } from '@openpacker/contracts';
import { buildOrder } from './frozen-build-order.js';
import {
  detectNpmLifecycleScripts,
  runDeclaredLifecycleScripts,
} from './lifecycle.js';
import { isolateProjectStoreFromSharedLinks } from './shared-store-tree.js';
import { OpmError } from './types.js';

/** A package whose approved scripts ran. */
export interface BuiltPackage {
  name: string;
  version: string;
  path: string;
}

/**
 * The `npm`, `pnpm` and `yarn` an approved script finds first on its PATH
 * (ADR 0061): opm's, which run a script of the package's own through
 * `opm run` inside the same jail and refuse every other command.
 */
export interface ScriptShims {
  /** Their directory, first on the script's PATH. */
  bin: string;
  /** What they read to run, mounted read-only in the jail: never written by a script. */
  readonlyPaths: readonly string[];
  /** Set in the script's environment: `npm_execpath` and `npm_node_execpath`. */
  env: Readonly<Record<string, string>>;
}

/** The approved scripts that ran, in the order they ran, and the cycles among them. */
export interface ApprovedBuilds {
  built: BuiltPackage[];
  /** Packages that depend on each other, more than one of them approved: run in the lock's order. */
  cycles: BuiltPackage[][];
}

const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEPENDENCY_LISTS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * The names the installed `package.json` in `dir` depends on, from its three
 * lists, read without following a link and bounded; none when it cannot be
 * read as one.
 */
async function dependencyNamesIn(dir: string): Promise<string[]> {
  let text: string;
  try {
    const handle = await open(
      join(dir, 'package.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAXIMUM_MANIFEST_BYTES) return [];
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof manifest !== 'object' || manifest === null) return [];
  const names: string[] = [];
  for (const list of DEPENDENCY_LISTS) {
    // SAFETY: checked above to be an object; each field is checked below.
    const value: unknown = (manifest as Record<string, unknown>)[list];
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      continue;
    for (const name of Object.keys(value))
      if (!names.includes(name)) names.push(name);
  }
  return names;
}

const labelOf = (pkg: FrozenLockPackage): BuiltPackage => ({
  name: pkg.packageName,
  version: pkg.version,
  path: pkg.path,
});

/** Whether the project approved this package's install scripts, by name or `name@version`. */
export function buildApproved(
  approved: FrozenLock['approvedBuilds'],
  pkg: Pick<FrozenLockPackage, 'packageName' | 'version'>,
): boolean {
  return (
    approved !== undefined &&
    (approved.entries.includes(pkg.packageName) ||
      approved.entries.includes(`${pkg.packageName}@${pkg.version}`))
  );
}

/** The jail's policy for one approved package: its scripts, and nothing else. */
function approvalPolicy(purl: string): PolicyInput {
  // SAFETY: the fields the lifecycle funnel reads; the rest keep their defaults.
  return {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    allowLifecycleScripts: false,
    allowedLifecycleScriptPackages: [purl],
    sandboxMode: 'fail-closed',
    sandboxRequired: true,
  } as PolicyInput;
}

/**
 * Make each symbolic link under `dir` that names a file under `dir` a hard
 * link to that file, and refuse any other.
 */
async function linksToFiles(
  dir: string,
  label: string,
  top = dir,
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await linksToFiles(path, label, top);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const text = await readlink(path);
    const target = resolve(dirname(path), text);
    const inside = (candidate: string) =>
      candidate === top || candidate.startsWith(`${top}${sep}`);
    const real = await realpath(target).catch(() => undefined);
    const info = real === undefined ? undefined : await lstat(real);
    if (real === undefined || !inside(real) || !info!.isFile())
      throw new OpmError(
        'UNSAFE_PATH',
        `The install script of ${label} left the link ${relative(top, path)} -> ${text}, which is not a file of the package's own; node_modules holds no symlink but a workspace member's`,
      );
    const tmp = `${path}.opm-link`;
    await link(real, tmp);
    await unlink(path);
    await rename(tmp, path);
  }
}

/**
 * Run the approved install scripts of the packages `lock` places under
 * `root`, each in place and in dependency order, and say which ran. A script
 * that fails stops the install, as it stops npm's.
 */
export async function runApprovedBuilds(input: {
  root: string;
  lock: Pick<
    FrozenLock,
    'packages' | 'approvedBuilds' | 'skipped' | 'workspace'
  >;
  /** Whether each package declares an install script, by path. */
  declares: ReadonlyMap<string, boolean>;
  /** opm's npm, pnpm and yarn; absent, a script finds what the jail's PATH holds. */
  shims?: ScriptShims | undefined;
}): Promise<ApprovedBuilds> {
  const approved = input.lock.approvedBuilds;
  if (approved === undefined) return { built: [], cycles: [] };
  const root = await realpath(input.root);
  const { order, cycles } = await buildOrder({
    packages: input.lock.packages,
    runs: (pkg) =>
      input.declares.get(pkg.path) === true && buildApproved(approved, pkg),
    links: input.lock.workspace?.layout.links ?? [],
    stops: new Set(
      input.lock.skipped
        .filter((skip) => skip.kind === 'bundled')
        .map((skip) => skip.path),
    ),
    dependencyNames: (dir) => dependencyNamesIn(join(root, ...dir.split('/'))),
  });
  const shims = input.shims;
  const built: BuiltPackage[] = [];
  for (const pkg of order) {
    const dir = join(root, ...pkg.path.split('/'));
    await isolateProjectStoreFromSharedLinks(dir);
    const declared = await detectNpmLifecycleScripts(dir);
    await runDeclaredLifecycleScripts({
      declared,
      packageDir: dir,
      packageId: pkg.purl,
      policy: approvalPolicy(pkg.purl),
      readonlyPaths: [root, ...(shims?.readonlyPaths ?? [])],
      pathPrefix: [
        ...(shims === undefined ? [] : [shims.bin]),
        join(dir, 'node_modules', '.bin'),
        join(root, 'node_modules', '.bin'),
        dirname(process.execPath),
      ],
      ...(shims !== undefined && { env: shims.env }),
    });
    await linksToFiles(dir, `${pkg.packageName}@${pkg.version} (${pkg.path})`);
    built.push(labelOf(pkg));
  }
  return { built, cycles: cycles.map((cycle) => cycle.map(labelOf)) };
}
