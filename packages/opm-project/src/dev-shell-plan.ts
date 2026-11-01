import { environmentPaths } from './generations.js';
import { environmentVariables } from './environment-script.js';
import { projectPaths } from './paths.js';
import { readManifestFile } from './project.js';
import { OpmError } from './types.js';
import type { OpmManifest } from './types.js';
import type { DevShellPlan, ShellIsolatePrefer } from '@openpacker/sandbox';

export type { DevShellPlan, ShellIsolatePrefer };

const ISOLATE_VALUES = new Set(['off', 'auto', 'mxc', 'lxc']);

export function parseShellIsolatePrefer(
  raw: string | undefined,
  fallback: ShellIsolatePrefer | 'off' = 'auto',
): ShellIsolatePrefer | 'off' {
  if (raw === undefined || raw === '') return fallback;
  if (!ISOLATE_VALUES.has(raw)) {
    throw new OpmError(
      'INVALID_MANIFEST',
      `environment.shell_isolate must be off|auto|mxc|lxc, got ${JSON.stringify(raw)}`,
    );
  }
  return raw as ShellIsolatePrefer | 'off';
}

export function shellIsolatePreferFromManifest(
  manifest: OpmManifest,
): ShellIsolatePrefer | 'off' {
  return manifest.environment?.shellIsolate ?? 'off';
}

export function devShellNetworkFromManifest(manifest: OpmManifest): boolean {
  return manifest.environment?.network === true;
}

/**
 * Bind plan for an isolated dev shell: project tree RW, generation store and
 * ledger RO, resolved env from the current generation.
 */
export async function planDevShell(input: {
  root: string;
  cwd?: string;
  network?: boolean;
}): Promise<DevShellPlan> {
  const paths = projectPaths(input.root);
  const envPaths = environmentPaths(input.root);
  const env = await environmentVariables({ root: input.root });

  const readonlyPaths = [
    paths.lock,
    envPaths.generations,
    envPaths.environmentState,
    envPaths.storeReferences,
    paths.store,
    paths.bin,
    paths.links,
  ];

  return {
    projectRoot: paths.root,
    cwd: input.cwd ?? paths.root,
    readonlyPaths,
    readwritePaths: [paths.root],
    env,
    network: input.network ?? false,
  };
}

export async function loadDevShellContext(input: {
  root: string;
  cwd?: string;
}): Promise<{
  plan: DevShellPlan;
  prefer: ShellIsolatePrefer | 'off';
}> {
  const manifest = await readManifestFile(projectPaths(input.root).manifest);
  const prefer = shellIsolatePreferFromManifest(manifest);
  const plan = await planDevShell({
    root: input.root,
    ...(!(input.cwd === undefined) && { cwd: input.cwd }),
    network: devShellNetworkFromManifest(manifest),
  });
  return { plan, prefer };
}
