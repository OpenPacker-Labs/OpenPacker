import { accessSync, constants, existsSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { SandboxBackendError, spawnCapture } from './mock.js';
import { sensitiveMaskDirectories, sensitiveMaskFiles } from '../paths.js';
import type { BackendProbe, SandboxBackend } from '../types.js';

function which(bin: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const sep = platform() === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = resolve(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function probeNativeBackends(): BackendProbe[] {
  const probes: BackendProbe[] = [];
  if (platform() === 'linux') {
    const bwrap = which('bwrap');
    probes.push(
      bwrap
        ? { id: 'native-bwrap', available: true }
        : {
            id: 'native-bwrap',
            available: false,
            reason: 'bwrap not found on PATH',
          },
    );
  } else if (platform() === 'darwin') {
    const se = which('sandbox-exec');
    probes.push(
      se
        ? { id: 'native-seatbelt', available: true }
        : {
            id: 'native-seatbelt',
            available: false,
            reason: 'sandbox-exec not found',
          },
    );
  } else if (platform() === 'win32') {
    // Without MXC, Windows has no lightweight native jail in this package yet.
    probes.push({
      id: 'native-process',
      available: false,
      reason:
        'native Windows process isolation requires MXC or a future native helper',
    });
  }
  return probes;
}

/**
 * Bubblewrap backend (Linux). Read-only bind of `/` with RW overlays for
 * granted paths; network denied unless requested.
 */
export function createBwrapBackend(): SandboxBackend {
  const bwrap = which('bwrap');
  if (!bwrap) {
    throw new SandboxBackendError('UNAVAILABLE', 'bwrap not found on PATH');
  }
  return {
    id: 'native-bwrap',
    async run(input) {
      const argv = buildBwrapArgv({
        bwrap,
        command: input.argv,
        cwd: input.cwd,
        readwritePaths: input.readwritePaths,
        readonlyPaths: input.readonlyPaths,
        network: input.network,
      });
      return spawnCapture({
        argv,
        cwd: input.cwd,
        env: input.env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

export function buildBwrapArgv(input: {
  bwrap: string;
  command: readonly string[];
  cwd: string;
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  network: boolean;
}): string[] {
  // Defense-in-depth profile (Aube-aligned):
  // - unshare net unless granted
  // - host root RO
  // - mask home / secret dirs so RO root cannot leak credentials
  // - RW only for declared package / temp paths (re-bound after masks)
  const args: string[] = [
    input.bwrap,
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
  ];
  if (!input.network) args.push('--unshare-net');

  args.push('--ro-bind', '/', '/');
  args.push('--dev', '/dev');
  args.push('--proc', '/proc');
  args.push('--tmpfs', '/tmp');
  args.push('--tmpfs', '/var/tmp');

  // Mask credential-bearing directories after the RO root bind. Package RW
  // binds below re-expose only the granted trees.
  for (const dir of sensitiveMaskDirectories()) {
    if (existsSync(dir)) args.push('--tmpfs', dir);
  }
  for (const file of sensitiveMaskFiles()) {
    if (existsSync(file)) args.push('--ro-bind', '/dev/null', file);
  }

  // Re-expose the executable after masks (nvm/mise node lives under $HOME).
  const command0 = input.command[0];
  if (command0 && command0.includes('/')) {
    try {
      const execPath = resolve(command0);
      if (existsSync(execPath)) args.push('--ro-bind', execPath, execPath);
    } catch {
      // ignore
    }
  }

  const rw = new Set(
    [...input.readwritePaths, input.cwd].map((p) => resolve(p)),
  );
  for (const path of rw) {
    args.push('--bind', path, path);
  }
  for (const path of input.readonlyPaths.map((p) => resolve(p))) {
    if (rw.has(path)) continue;
    args.push('--ro-bind', path, path);
  }

  args.push('--chdir', resolve(input.cwd));
  args.push('--');
  args.push(...input.command);
  return args;
}

/**
 * Seatbelt backend (macOS): generate a narrow profile and run via sandbox-exec.
 * Network deny + write only to granted paths when possible.
 */
export function createSeatbeltBackend(): SandboxBackend {
  const se = which('sandbox-exec');
  if (!se) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'sandbox-exec not found on PATH',
    );
  }
  return {
    id: 'native-seatbelt',
    async run(input) {
      const profile = buildSeatbeltProfile({
        readwritePaths: [...input.readwritePaths, input.cwd],
        readonlyPaths: input.readonlyPaths,
        network: input.network,
      });
      // sandbox-exec -p PROFILE command...
      return spawnCapture({
        argv: [se, '-p', profile, ...input.argv],
        cwd: input.cwd,
        env: input.env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

export function buildSeatbeltProfile(input: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  network: boolean;
}): string {
  const writes = input.readwritePaths
    .map((p) => `(allow file-write* (subpath ${JSON.stringify(resolve(p))}))`)
    .join('\n  ');
  // Prefer explicit RO trees when provided; otherwise allow reading system
  // paths but still deny the home/secret subpaths below.
  const reads =
    input.readonlyPaths.length > 0
      ? input.readonlyPaths
          .map(
            (p) => `(allow file-read* (subpath ${JSON.stringify(resolve(p))}))`,
          )
          .join('\n  ')
      : `(allow file-read-data file-read-metadata
    (regex #"^/(usr|bin|sbin|lib|lib64|System|Library|Applications|opt|private/etc|etc|dev|tmp|var/folders)/")
    (literal "/")
    (literal "/private")
  )`;
  const deniedHomes = sensitiveMaskDirectories()
    .map(
      (p) =>
        `(deny file-read* file-write* (subpath ${JSON.stringify(resolve(p))}))`,
    )
    .join('\n  ');
  const net = input.network ? '(allow network*)' : '(deny network*)';
  return `
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
${reads}
${deniedHomes}
${writes}
${net}
`.trim();
}

export function createNativeBackend(): SandboxBackend | undefined {
  if (platform() === 'linux' && which('bwrap')) return createBwrapBackend();
  if (platform() === 'darwin' && which('sandbox-exec'))
    return createSeatbeltBackend();
  return undefined;
}
