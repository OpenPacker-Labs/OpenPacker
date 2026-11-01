import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SandboxBackendError } from './mock.js';
import type { BackendProbe, SandboxBackend } from '../types.js';

const execFile = promisify(
  (
    command: string,
    args: readonly string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => callback(error, stdout, stderr));
    child.on('close', (code) => {
      if (code === 0) callback(null, stdout, stderr);
      else
        callback(
          new Error(
            `${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`,
          ),
          stdout,
          stderr,
        );
    });
  },
);

export type LxcCli = 'incus' | 'lxc';

/** Which container CLI is on PATH and responds to `info`. */
export async function resolveLxcCli(): Promise<LxcCli | undefined> {
  if (platform() !== 'linux') return undefined;
  for (const cli of ['incus', 'lxc'] as const) {
    try {
      await execFile(cli, ['info']);
      return cli;
    } catch {
      // try next
    }
  }
  return undefined;
}

export async function probeLxc(): Promise<BackendProbe> {
  const cli = await resolveLxcCli();
  if (!cli) {
    return {
      id: 'lxc',
      available: false,
      reason:
        platform() !== 'linux'
          ? 'LXC/Incus dev shells require Linux'
          : 'incus or lxc CLI not found or not usable',
    };
  }
  return { id: 'lxc', available: true };
}

/** Default ephemeral image for isolated dev shells (small, widely cached). */
export const LXC_DEV_SHELL_IMAGE = 'images:ubuntu/24.04';

export interface LxcBindDevice {
  name: string;
  source: string;
  path: string;
  readonly: boolean;
}

/** Plan disk devices for project root, store, and generation metadata. */
export function planLxcBindDevices(input: {
  projectRoot: string;
  readonlyPaths: readonly string[];
  readwritePaths: readonly string[];
}): LxcBindDevice[] {
  const root = realpathSync(resolve(input.projectRoot));
  const devices: LxcBindDevice[] = [
    {
      name: 'project',
      source: root,
      path: root,
      readonly: false,
    },
  ];
  let index = 0;
  const seen = new Set<string>([root]);
  for (const path of [...input.readonlyPaths, ...input.readwritePaths]) {
    const resolved = realpathSync(resolve(path));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const readOnly = input.readonlyPaths.some(
      (candidate) => realpathSync(resolve(candidate)) === resolved,
    );
    devices.push({
      name: `bind${index++}`,
      source: resolved,
      path: resolved,
      readonly:
        readOnly &&
        !input.readwritePaths.some(
          (candidate) => realpathSync(resolve(candidate)) === resolved,
        ),
    });
  }
  return devices;
}

async function launchEphemeral(
  cli: LxcCli,
  name: string,
  devices: readonly LxcBindDevice[],
): Promise<void> {
  await execFile(cli, ['launch', LXC_DEV_SHELL_IMAGE, name, '--ephemeral']);
  for (const device of devices) {
    await execFile(cli, [
      'config',
      'device',
      'add',
      name,
      device.name,
      'disk',
      `source=${device.source}`,
      `path=${device.path}`,
      ...(device.readonly ? ['readonly=true'] : []),
    ]);
  }
}

async function deleteContainer(cli: LxcCli, name: string): Promise<void> {
  try {
    await execFile(cli, ['delete', name, '--force']);
  } catch {
    // best effort
  }
}

function envPairs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

/**
 * LXC/Incus backend for dev-shell profile runs.
 *
 * Launches an ephemeral container, bind-mounts the planned paths, and execs argv
 * inside it. Interactive shells are argv ending in a login shell.
 */
export async function createLxcBackend(): Promise<SandboxBackend> {
  const probe = await probeLxc();
  if (!probe.available) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      probe.reason ?? 'LXC/Incus unavailable',
    );
  }
  const cli = (await resolveLxcCli())!;
  return {
    id: 'lxc',
    async run(input) {
      if (input.profile !== 'dev-shell') {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'LXC backend only supports dev-shell profile',
        );
      }
      if (input.executableAuthority !== undefined) {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'LXC cannot consume stable executable handle authorities',
        );
      }
      const devices = planLxcBindDevices({
        projectRoot: input.cwd,
        readonlyPaths: input.readonlyPaths,
        readwritePaths: input.readwritePaths,
      });
      const name = `opm-shell-${process.pid}-${Date.now()}`;
      try {
        await launchEphemeral(cli, name, devices);
        const execArgs = [
          'exec',
          name,
          '--cwd',
          input.cwd,
          '--',
          'env',
          ...envPairs(input.env),
          ...input.argv,
        ];
        if (input.output) {
          return await spawnWithSink(cli, execArgs, input);
        }
        return await spawnCaptureCli(cli, execArgs, input);
      } finally {
        await deleteContainer(cli, name);
      }
    },
  };
}

async function spawnCaptureCli(
  cli: LxcCli,
  args: string[],
  input: {
    maximumStdoutBytes: number;
    maximumStderrBytes: number;
    maximumOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const onAbort = () => {
      child.kill('SIGTERM');
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= input.maximumStdoutBytes)
        stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= input.maximumStderrBytes)
        stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function spawnWithSink(
  cli: LxcCli,
  args: string[],
  input: {
    output?: import('../types.js').OutputSink;
    signal?: AbortSignal;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cli, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const onAbort = () => child.kill('SIGTERM');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const forward = (
      stream: NodeJS.ReadableStream | null,
      kind: 'stdout' | 'stderr',
    ) => {
      stream?.on('data', (chunk: Buffer) => {
        void input.output?.[kind](chunk);
      });
    };
    forward(child.stdout, 'stdout');
    forward(child.stderr, 'stderr');
    child.on('error', reject);
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode: code ?? 1, stdout: '', stderr: '' });
    });
  });
}

/** Run an interactive or one-shot command with inherited stdio (dev shell entry). */
export async function execLxcDevShell(input: {
  cwd: string;
  env: Readonly<Record<string, string>>;
  argv: readonly string[];
  readonlyPaths: readonly string[];
  readwritePaths: readonly string[];
  network: boolean;
  signal?: AbortSignal;
}): Promise<number> {
  const backend = await createLxcBackend();
  const result = await backend.run({
    argv: input.argv,
    cwd: input.cwd,
    hostEnv: {},
    env: input.env,
    readwritePaths: input.readwritePaths,
    readonlyPaths: input.readonlyPaths,
    network: input.network,
    profile: 'dev-shell',
    maximumStdoutBytes: 1024 * 1024,
    maximumStderrBytes: 1024 * 1024,
    maximumOutputBytes: 2 * 1024 * 1024,
    output: {
      stdout(chunk) {
        process.stdout.write(chunk);
      },
      stderr(chunk) {
        process.stderr.write(chunk);
      },
    },
    ...(!(input.signal === undefined) && { signal: input.signal }),
  });
  return result.exitCode;
}

export function lxcUnavailableMessage(reason?: string): string {
  return reason ?? 'LXC/Incus is not available on this host';
}
