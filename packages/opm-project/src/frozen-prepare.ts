/**
 * The part of a frozen install that reads and judges and touches nothing: find
 * the project, read its lock through the ecosystem's adapter, refuse what the
 * lock holds that cannot be installed, and judge every package against the
 * project's policy. `installFrozen` goes on from here to fetch and write;
 * `planFrozen` stops here, which is why a plan that passes fails later only on
 * the network, the store or the disk.
 */

import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  detectNativeTarget,
  echoed,
  echoedValue,
  type ArchivePlatform,
  type DetectedProject,
  type FrozenLock,
  type FrozenOmit,
  type NativeTarget,
  type ProjectFormat,
} from '@openpacker/adapter-core';
import { requireAdapterRegistry } from './adapters.js';
import { type FrozenFetchOptions } from './frozen-fetch.js';
import { assertPatchesFit } from './frozen-patch-fit.js';
import {
  assertFrozenAllowed,
  frozenPolicyDocument,
  listLines,
} from './frozen-policy.js';
import { labelOf, redactSource } from './frozen-store.js';
import {
  prepareFrozenWorkspace,
  type FrozenWorkspaceRequest,
} from './frozen-workspace.js';
import { strongestClaims, type IntegrityClaim } from './integrity.js';
import { MANIFEST_NAME, projectPaths } from './paths.js';
import { readManifestFile } from './project.js';
import type { StepOptions } from './project-step.js';
import { registryEndpoint } from './registry.js';
import type { OpmManifest } from './types.js';
import { OpmError } from './types.js';

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
  /**
   * Every machine whose optional packages are installed (pnpm's
   * `supportedArchitectures`); a package is installed when it runs on any one.
   * `target` alone by default.
   */
  targets?: readonly NativeTarget[];
  /** `project`: the platforms the project itself names, as pnpm's `supportedArchitectures` does. */
  architectures?: 'project';
  /** The time policy is evaluated at. */
  now?: () => string;
  /** Told what a killed step left and this one finished first. */
  step?: StepOptions;
  /** Archives read at the same time. */
  concurrency?: number;
  signal?: AbortSignal;
}

/** What `prepareFrozen` found out, for the install or the plan to go on from. */
export interface PreparedFrozen {
  started: number;
  /** When the lock had been read and judged, on the same clock as `started`. */
  read: number;
  root: string;
  env: NodeJS.ProcessEnv;
  ecosystem: string;
  format: ProjectFormat;
  detected: DetectedProject;
  offline: boolean;
  lock: FrozenLock;
  /** The strongest claims of each package's integrity, by path. */
  claims: Map<string, IntegrityClaim[]>;
}

export function now(): number {
  return performance.now();
}

/** The registry a package with no URL in its lock is fetched from: the operator's, else the public one. */
function registryFor(ecosystem: string): string | undefined {
  try {
    return registryEndpoint(ecosystem);
  } catch (error) {
    // An ecosystem with no registry endpoint is one whose locks name URLs; one
    // whose operator named an unusable endpoint is told so.
    if (error instanceof OpmError && error.code === 'UNSUPPORTED_ECOSYSTEM')
      return undefined;
    throw error;
  }
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
      `No project in ${root} has a lock opm can install exactly. It needs a package.json and a package-lock.json or pnpm-lock.yaml side by side`,
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
export function adapterFailure(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error instanceof OpmError) return error;
  const codes: Record<string, string> = {
    INVALID_LOCKFILE: 'INVALID_LOCK',
    INVALID_MANIFEST: 'INVALID_MANIFEST',
    NOT_FOUND: 'NOT_FOUND',
    UNSAFE_PATH: 'UNSAFE_PATH',
    CASE_COLLISION: 'UNSAFE_PATH',
    LAYOUT_PATHS_INVALID: 'INVALID_LOCK',
    LAYOUT_TOO_LARGE: 'SIZE_LIMIT',
    PATCH_FAILED: 'PATCH_FAILED',
    INVALID_PATCH: 'INVALID_PATCH',
    SIZE_LIMIT: 'SIZE_LIMIT',
  };
  // SAFETY: provider errors carry an optional string `code`.
  const code = (error as { code?: unknown }).code;
  const mapped = typeof code === 'string' ? codes[code] : undefined;
  return mapped === undefined
    ? error
    : new OpmError(mapped, error.message, { cause: error });
}

export async function prepareFrozen(
  input: FrozenInstallInput,
  /** What archives declared, for a second read (`frozen-archive-platform.ts`). */
  archivePlatforms?: ReadonlyMap<string, ArchivePlatform>,
): Promise<PreparedFrozen> {
  const started = now();
  const root = resolve(input.root);
  const env = input.env ?? process.env;
  const { ecosystem, format, detected } = await findFrozenProject(
    root,
    input.ecosystem,
  );
  const manifest = await readProjectManifest(root);
  const offline = input.offline ?? manifest?.options.offline ?? false;

  let workspace: Awaited<ReturnType<typeof prepareFrozenWorkspace>>;
  let lock: FrozenLock;
  try {
    // Whose rules read the members depends on the lock the project is
    // installed from, which the format decides (and may refuse to).
    const tool =
      (await format.workspaceToolFor?.(detected)) ?? format.workspaceTool;
    workspace = await prepareFrozenWorkspace(
      root,
      format,
      input.workspace,
      tool,
    );
    const target = input.target ?? detectNativeTarget();
    const registry = registryFor(ecosystem);
    lock = await format.readFrozenLock!(detected, {
      target,
      ...(input.targets !== undefined && { targets: input.targets }),
      ...(input.architectures !== undefined && {
        architectures: input.architectures,
      }),
      ...(registry !== undefined && { registry }),
      omit: new Set(input.omit ?? []),
      ...(workspace !== undefined && { workspace }),
      ...(archivePlatforms !== undefined && { archivePlatforms }),
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
  await assertPatchesFit(lock.packages, format, root, env);
  const claims = new Map<string, IntegrityClaim[]>(
    lock.packages.map((pkg) => [
      pkg.path,
      strongestClaims(pkg.integrity, labelOf(pkg)),
    ]),
  );
  return {
    started,
    read: now(),
    root,
    env,
    ecosystem,
    format,
    detected,
    offline,
    lock,
    claims,
  };
}
