import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runInSandbox,
  type PackageGrants,
  type SandboxBackend,
  type SandboxOutcome,
  type SandboxPolicy,
} from '@openpacker/sandbox';
import type { PolicyInput } from '@openpacker/contracts';
import { OpmError } from './types.js';

const LIFECYCLE_EVENTS = ['preinstall', 'install', 'postinstall'] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface DeclaredLifecycleScripts {
  events: Partial<Record<LifecycleEvent, string>>;
}

/**
 * Read npm-style lifecycle scripts from a materialised package directory.
 * Other ecosystems return empty until adapters declare their own shapes.
 */
export async function detectNpmLifecycleScripts(
  storePath: string,
): Promise<DeclaredLifecycleScripts> {
  const pkgPath = join(storePath, 'package', 'package.json');
  const alt = join(storePath, 'package.json');
  for (const candidate of [pkgPath, alt]) {
    try {
      const text = await readFile(candidate, 'utf8');
      const json = JSON.parse(text) as { scripts?: Record<string, string> };
      const scripts = json.scripts ?? {};
      const events: DeclaredLifecycleScripts['events'] = {};
      for (const event of LIFECYCLE_EVENTS) {
        const body = scripts[event];
        if (typeof body === 'string' && body.trim() !== '')
          events[event] = body;
      }
      return { events };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof SyntaxError) return { events: {} };
      throw error;
    }
  }
  return { events: {} };
}

export function hasLifecycleScripts(
  declared: DeclaredLifecycleScripts,
): boolean {
  return Object.keys(declared.events).length > 0;
}

/**
 * Whether policy allows running lifecycle scripts for this package id.
 * Default is refuse (ADR 0033 / supply-chain).
 */
export function lifecycleScriptsAllowed(
  policy: PolicyInput | undefined,
  packageId: string,
): boolean {
  const list = policy?.allowedLifecycleScriptPackages ?? [];
  if (list.some((entry) => packageGrantMatches(packageId, entry))) return true;
  // Global allow is insecure. Strict mode (default) requires an allowlist hit.
  const ext = policy as
    | (PolicyInput & { strictLifecycleAllowlist?: boolean })
    | undefined;
  const isStrict = ext?.strictLifecycleAllowlist !== false;
  if (policy?.allowLifecycleScripts === true && !isStrict) return true;
  return false;
}

function packageGrantMatches(packageId: string, entry: string): boolean {
  if (entry === packageId) return true;
  if (entry.endsWith('*') && packageId.startsWith(entry.slice(0, -1)))
    return true;
  if (!packageId.startsWith(entry)) return false;
  const last = entry.charAt(entry.length - 1);
  if (last === '@' || last === '/' || last === '?' || last === '#') return true;
  const next = packageId.charAt(entry.length);
  return next === '@' || next === '/' || next === '?' || next === '#';
}

export function sandboxPolicyFromProject(
  policy: PolicyInput | undefined,
): SandboxPolicy {
  const packages = policy?.sandboxPackageGrants as
    | Readonly<Record<string, PackageGrants>>
    | undefined;
  // Extended knobs may live on PolicyInput once schema is regenerated, or on
  // a nested object written by toml.
  const ext = (policy ?? {}) as PolicyInput & {
    projectWrite?: boolean;
    minimalPath?: boolean;
    strictLifecycleAllowlist?: boolean;
    allowDangerousGrants?: boolean;
    legacyFatRoot?: boolean;
    timeoutMs?: number;
  };
  return {
    enabled: policy?.sandboxMode !== 'off',
    mode: policy?.sandboxMode ?? 'fail-closed',
    prefer: policy?.sandboxPrefer ?? 'auto',
    required:
      policy?.sandboxRequired ??
      (policy?.sandboxMode === undefined ||
        policy.sandboxMode === 'fail-closed'),
    allowHostUnsandboxedInstall: policy?.allowHostUnsandboxedInstall ?? false,
    projectWrite: ext.projectWrite ?? false,
    minimalPath: ext.minimalPath ?? true,
    strictLifecycleAllowlist: ext.strictLifecycleAllowlist ?? true,
    allowDangerousGrants: ext.allowDangerousGrants ?? false,
    legacyFatRoot: ext.legacyFatRoot ?? false,
    ...(ext.timeoutMs === undefined ? {} : { timeoutMs: ext.timeoutMs }),
    ...(packages === undefined ? {} : { packages }),
  };
}

/**
 * Run one lifecycle script inside the jail. Single funnel — install and
 * rebuild paths both call this rather than spawning shell themselves.
 */
export async function runLifecycleScript(input: {
  event: LifecycleEvent;
  script: string;
  packageDir: string;
  packageId: string;
  policy: PolicyInput | undefined;
  /** Shell binary; default /bin/sh -c. */
  shell?: readonly string[];
  /** Test seam: inject a backend. Production callers omit this. */
  backend?: SandboxBackend;
  directoryAuthority?: { fd: number; path: string };
}): Promise<SandboxOutcome> {
  if (!lifecycleScriptsAllowed(input.policy, input.packageId)) {
    throw new OpmError(
      'POLICY_DENIED',
      `Lifecycle script ${input.event} for ${input.packageId} is not allowlisted`,
    );
  }
  const shell = input.shell ?? ['/bin/sh', '-c'];
  const sandboxPolicy = sandboxPolicyFromProject(input.policy);
  const grants = input.policy?.sandboxPackageGrants?.[input.packageId] as
    | PackageGrants
    | undefined;

  const outcome = await runInSandbox({
    argv: [...shell, input.script],
    cwd: input.packageDir,
    env: {
      npm_lifecycle_event: input.event,
      npm_package_name: input.packageId,
      INIT_CWD: input.packageDir,
    },
    policy: sandboxPolicy,
    profile: 'package-exec',
    packageId: input.packageId,
    ...(grants === undefined ? {} : { grants }),
    // Package tree only — never the whole host (host installers use a
    // separate funnel with broader grants).
    readwritePaths: [input.packageDir],
    readonlyPaths: [],
    network: grants?.network === true,
    ...(input.directoryAuthority === undefined
      ? {}
      : { directoryAuthorities: [input.directoryAuthority] }),
    ...(input.backend === undefined ? {} : { backend: input.backend }),
  });

  // Fail-closed: a script that ran without an OS jail is ambient code
  // execution and must not look successful.
  const mode = sandboxPolicy.mode ?? 'fail-closed';
  if (
    !outcome.enforced &&
    (mode === 'fail-closed' || sandboxPolicy.required !== false)
  ) {
    throw new OpmError(
      'SANDBOX_UNAVAILABLE',
      `Cannot run ${input.event} for ${input.packageId}: sandbox was not enforced ` +
        `(backend=${outcome.backend})`,
    );
  }
  return outcome;
}

/**
 * Run all declared lifecycle events in order under the jail.
 * Stops on first non-zero exit.
 */
export async function runDeclaredLifecycleScripts(input: {
  declared: DeclaredLifecycleScripts;
  packageDir: string;
  packageId: string;
  policy: PolicyInput | undefined;
  directoryAuthority?: { fd: number; path: string };
}): Promise<{ executed: boolean; outcomes: SandboxOutcome[] }> {
  if (!hasLifecycleScripts(input.declared)) {
    return { executed: false, outcomes: [] };
  }
  if (!lifecycleScriptsAllowed(input.policy, input.packageId)) {
    return { executed: false, outcomes: [] };
  }
  const outcomes: SandboxOutcome[] = [];
  for (const event of LIFECYCLE_EVENTS) {
    const script = input.declared.events[event];
    if (!script) continue;
    const outcome = await runLifecycleScript({
      event,
      script,
      packageDir: input.packageDir,
      packageId: input.packageId,
      policy: input.policy,
      ...(input.directoryAuthority === undefined
        ? {}
        : { directoryAuthority: input.directoryAuthority }),
    });
    outcomes.push(outcome);
    if (outcome.exitCode !== 0) {
      throw new OpmError(
        'LIFECYCLE_FAILED',
        `${event} for ${input.packageId} exited ${outcome.exitCode}` +
          (outcome.stderr ? `: ${outcome.stderr.trim()}` : ''),
      );
    }
  }
  return { executed: outcomes.length > 0, outcomes };
}
