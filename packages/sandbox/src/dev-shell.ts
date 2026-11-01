import { createLxcBackend } from './backends/lxc.js';
import { createMxcBackend, probeMxc } from './backends/mxc.js';
import { probeLxc } from './backends/lxc.js';
import { createMockBackend, SandboxBackendError } from './backends/mock.js';
import type { SandboxBackend } from './types.js';
import { scrubEnvironment, defaultJailHomeRoot } from './env.js';
import { resolvePolicy } from './policy.js';
import type { OutputSink, SandboxPolicy, ShellIsolatePrefer } from './types.js';

export type { ShellIsolatePrefer };

export interface DevShellPlan {
  projectRoot: string;
  cwd: string;
  readonlyPaths: readonly string[];
  readwritePaths: readonly string[];
  env: Readonly<Record<string, string>>;
  network: boolean;
}

export interface RunDevShellInput {
  plan: DevShellPlan;
  prefer: ShellIsolatePrefer;
  /** When absent, starts an interactive login shell. */
  argv?: readonly string[];
  policy?: SandboxPolicy;
  backend?: SandboxBackend;
  output?: OutputSink;
  signal?: AbortSignal;
}

export interface DevShellProbe {
  id: 'mxc' | 'lxc';
  available: boolean;
  reason?: string;
}

export async function probeDevShellBackends(): Promise<DevShellProbe[]> {
  const [mxc, lxc] = await Promise.all([probeMxc(), probeLxc()]);
  return [
    {
      id: 'mxc',
      available: mxc.available,
      ...(!mxc.available && { reason: mxc.reason }),
    },
    {
      id: 'lxc',
      available: lxc.available,
      ...(!lxc.available && { reason: lxc.reason }),
    },
  ];
}

export async function resolveDevShellBackend(
  prefer: ShellIsolatePrefer,
): Promise<SandboxBackend | undefined> {
  if (prefer === 'mxc') {
    try {
      return await createMxcBackend();
    } catch {
      return undefined;
    }
  }
  if (prefer === 'lxc') {
    try {
      return await createLxcBackend();
    } catch {
      return undefined;
    }
  }
  try {
    return await createLxcBackend();
  } catch {
    try {
      return await createMxcBackend();
    } catch {
      return undefined;
    }
  }
}

export function devShellUnavailableMessage(probes: DevShellProbe[]): string {
  const parts = probes
    .filter((probe) => !probe.available)
    .map((probe) => `${probe.id}: ${probe.reason ?? 'unavailable'}`);
  return `No isolated dev shell backend is available (${parts.join('; ')}). Install incus or @microsoft/mxc-sdk on a supported host, or run without --isolate.`;
}

function shellArgv(extra?: readonly string[]): string[] {
  if (extra && extra.length > 0) return [...extra];
  const shell = process.env.SHELL ?? '/bin/sh';
  return shell.endsWith('sh') ? [shell, '-l'] : [shell];
}

/**
 * Run a command (or interactive shell) inside an isolated dev shell backend.
 */
export async function runDevShell(input: RunDevShellInput): Promise<{
  exitCode: number;
  backend: string;
}> {
  const policy = resolvePolicy(
    input.policy ?? { mode: 'fail-closed', prefer: 'auto' },
  );
  let backend = input.backend;
  if (!backend) backend = await resolveDevShellBackend(input.prefer);
  if (!backend) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      devShellUnavailableMessage(await probeDevShellBackends()),
    );
  }

  const argv = shellArgv(input.argv);
  const jailHome = defaultJailHomeRoot();
  const env = scrubEnvironment({
    extra: input.plan.env,
    jailHome,
    minimalPath: false,
  });
  const hostEnv = scrubEnvironment({ jailHome, minimalPath: true });
  const runInput = {
    argv,
    cwd: input.plan.cwd,
    hostEnv,
    env,
    readwritePaths: [...input.plan.readwritePaths],
    readonlyPaths: [...input.plan.readonlyPaths],
    network: input.plan.network,
    profile:
      backend.id === 'lxc' ? ('dev-shell' as const) : ('package-exec' as const),
    legacyFatRoot: policy.legacyFatRoot,
    maximumStdoutBytes: policy.maximumStdoutBytes,
    maximumStderrBytes: policy.maximumStderrBytes,
    maximumOutputBytes: policy.maximumOutputBytes,
    ...(!(input.output === undefined) && { output: input.output }),
    ...(!(input.signal === undefined) && { signal: input.signal }),
  };

  const result = await backend.run(runInput);
  return { exitCode: result.exitCode, backend: backend.id };
}

/** Interactive dev shell with inherited stdio. */
export async function runInteractiveDevShell(
  input: Omit<RunDevShellInput, 'output' | 'argv'>,
): Promise<number> {
  const sink: OutputSink = {
    stdout(chunk) {
      process.stdout.write(chunk);
    },
    stderr(chunk) {
      process.stderr.write(chunk);
    },
  };
  const { exitCode } = await runDevShell({ ...input, output: sink });
  return exitCode;
}

export { createMockBackend };

/** Host fallback: spawn on the host with the planned env (ADR 0061 explicit only). */
export async function runHostDevShell(
  plan: DevShellPlan,
  argv?: readonly string[],
): Promise<number> {
  const command = shellArgv(argv);
  const { spawn } = await import('node:child_process');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
