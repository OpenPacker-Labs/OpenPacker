import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SandboxBackendError, spawnCapture } from './mock.js';
import {
  networkToolMaskFiles,
  sensitiveMaskDirectories,
  sensitiveMaskFiles,
} from '../paths.js';
import type { BackendProbe, SandboxBackend, SandboxProfile } from '../types.js';

function regularFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) return path;
    if (stat.isSymbolicLink()) {
      const real = realpathSync(path);
      if (lstatSync(real).isFile()) return real;
    }
  } catch {
    // missing or unreadable
  }
  return undefined;
}

interface TrustedSandboxHelper {
  path: string;
  device: number;
  inode: number;
  ctimeMs: number;
  mtimeMs: number;
}

export function findTrustedSandboxHelper(
  bin: 'bwrap' | 'sandbox-exec',
  directories: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'],
): TrustedSandboxHelper | undefined {
  for (const directory of directories) {
    try {
      const path = realpathSync(resolve(directory, bin));
      const file = statSync(path);
      if (
        !file.isFile() ||
        file.uid !== 0 ||
        (file.mode & 0o111) === 0 ||
        (file.mode & 0o022) !== 0
      )
        continue;
      let ancestor = dirname(path);
      for (;;) {
        const info = statSync(ancestor);
        if (info.uid !== 0 || (info.mode & 0o022) !== 0)
          throw new Error('sandbox helper has a writable ancestor');
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      return {
        path,
        device: file.dev,
        inode: file.ino,
        ctimeMs: file.ctimeMs,
        mtimeMs: file.mtimeMs,
      };
    } catch {
      // try next
    }
  }
  return undefined;
}

function assertTrustedSandboxHelper(helper: TrustedSandboxHelper): void {
  const current = statSync(helper.path);
  if (
    !current.isFile() ||
    current.uid !== 0 ||
    (current.mode & 0o111) === 0 ||
    (current.mode & 0o022) !== 0 ||
    current.dev !== helper.device ||
    current.ino !== helper.inode ||
    current.ctimeMs !== helper.ctimeMs ||
    current.mtimeMs !== helper.mtimeMs
  )
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'Native sandbox helper identity changed before execution',
    );
}

export function probeNativeBackends(): BackendProbe[] {
  const probes: BackendProbe[] = [];
  if (platform() === 'linux') {
    const bwrap = findTrustedSandboxHelper('bwrap');
    probes.push(
      bwrap
        ? { id: 'native-bwrap', available: true }
        : {
            id: 'native-bwrap',
            available: false,
            reason: 'trusted bwrap not found in system paths',
          },
    );
  } else if (platform() === 'darwin') {
    const se = findTrustedSandboxHelper('sandbox-exec');
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
    probes.push({
      id: 'native-process',
      available: false,
      reason:
        'native Windows process isolation requires MXC or a future native helper',
    });
  }
  return probes;
}

/** Directories bind-mounted RO for minimal package-exec profiles. */
export function packageExecRoRoots(): string[] {
  const candidates = [
    '/usr',
    '/lib',
    '/lib64',
    '/lib32',
    '/bin',
    '/sbin',
    '/opt',
    // Node/OpenSSL certs and resolver basics (not full /etc).
    '/etc/ssl',
    '/etc/pki',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
    '/etc/localtime',
  ];
  return candidates.filter((p) => existsSync(p));
}

/**
 * Bubblewrap backend (Linux).
 */
export function createBwrapBackend(): SandboxBackend {
  const helper = findTrustedSandboxHelper('bwrap');
  if (!helper) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'trusted bwrap not found in system paths',
    );
  }
  return {
    id: 'native-bwrap',
    async run(input) {
      assertTrustedSandboxHelper(helper);
      const argv = buildBwrapArgv({
        bwrap: helper.path,
        command: input.argv,
        cwd: input.cwd,
        readwritePaths: input.readwritePaths,
        readonlyPaths: input.readonlyPaths,
        network: input.network,
        profile: input.profile,
        legacyFatRoot: input.legacyFatRoot === true,
        environment: input.env,
      });
      return spawnCapture({
        argv,
        cwd: input.cwd,
        env: input.hostEnv,
        maximumStdoutBytes: input.maximumStdoutBytes,
        maximumStderrBytes: input.maximumStderrBytes,
        maximumOutputBytes: input.maximumOutputBytes,
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
  profile: SandboxProfile;
  legacyFatRoot?: boolean;
  environment?: Readonly<Record<string, string>>;
}): string[] {
  const args: string[] = [
    input.bwrap,
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
  ];
  if (!input.network) args.push('--unshare-net');
  args.push('--clearenv');
  for (const [name, value] of Object.entries(input.environment ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  ))
    args.push('--setenv', name, value);

  const fat =
    input.profile === 'host-install' ||
    input.profile === 'ambient' ||
    input.legacyFatRoot === true;

  if (fat) {
    // Host-install / legacy: full RO root then RW overlays. Not a strong
    // confidentiality boundary — caller must set containmentLimited.
    args.push('--ro-bind', '/', '/');
  } else {
    // package-exec minimal: only toolchain + explicit trees (audit C1).
    for (const root of packageExecRoRoots()) {
      if (!existsSync(root)) continue;
      // Files vs directories: bwrap needs --ro-bind for both.
      args.push('--ro-bind', root, root);
    }
  }

  args.push('--dev', '/dev');
  args.push('--proc', '/proc');
  args.push('--tmpfs', '/tmp');
  args.push('--tmpfs', '/var/tmp');

  const command0 = input.command[0];
  if (command0 && command0.includes('/')) {
    try {
      const execPath = resolve(command0);
      if (existsSync(execPath)) {
        args.push('--ro-bind', execPath, execPath);
        // Also expose the interpreter's install prefix when under $HOME (nvm).
        const dir = dirname(execPath);
        if (existsSync(dir)) args.push('--ro-bind', dir, dir);
      }
    } catch {
      // ignore
    }
  }

  // Do not auto-RW cwd: package-exec often uses project as cwd with RO only.
  const rw = new Set(input.readwritePaths.map((p) => resolve(p)));
  const ro = new Set(input.readonlyPaths.map((p) => resolve(p)));
  // Ensure cwd is visible (RO if not granted RW).
  const cwdPath = resolve(input.cwd);
  if (!rw.has(cwdPath) && !ro.has(cwdPath)) ro.add(cwdPath);

  for (const path of rw) {
    if (!existsSync(path)) continue;
    args.push('--bind', path, path);
  }
  for (const path of ro) {
    if (rw.has(path)) continue;
    if (!existsSync(path)) continue;
    args.push('--ro-bind', path, path);
  }

  // Remask after RW overlays. Host-install `--bind / /` would otherwise
  // uncover credential files that were masked earlier.
  for (const dir of sensitiveMaskDirectories()) {
    try {
      if (lstatSync(dir).isDirectory()) args.push('--tmpfs', dir);
    } catch {
      // missing
    }
  }
  for (const file of sensitiveMaskFiles()) {
    const real = regularFile(file);
    if (real) args.push('--ro-bind', '/dev/null', real);
  }
  if (!input.network && input.profile === 'package-exec') {
    const seen = new Set<string>();
    for (const file of networkToolMaskFiles()) {
      const real = regularFile(file);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      args.push('--ro-bind', '/dev/null', real);
    }
  }

  args.push('--chdir', cwdPath);
  args.push('--');
  args.push(...input.command);
  return args;
}

export function createSeatbeltBackend(): SandboxBackend {
  const helper = findTrustedSandboxHelper('sandbox-exec');
  if (!helper) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'trusted sandbox-exec not found in system paths',
    );
  }
  return {
    id: 'native-seatbelt',
    async run(input) {
      assertTrustedSandboxHelper(helper);
      const cwdPath = resolve(input.cwd);
      const rw = [...input.readwritePaths];
      const ro = [...input.readonlyPaths];
      if (!rw.map((p) => resolve(p)).includes(cwdPath)) ro.push(cwdPath);
      const profile = buildSeatbeltProfile({
        readwritePaths: rw,
        readonlyPaths: ro,
        network: input.network,
        profile: input.profile,
        legacyFatRoot: input.legacyFatRoot === true,
      });
      return spawnCapture({
        argv: [
          helper.path,
          '-p',
          profile,
          '/usr/bin/env',
          '-i',
          ...Object.entries(input.env)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => `${name}=${value}`),
          ...input.argv,
        ],
        cwd: input.cwd,
        env: input.hostEnv,
        maximumStdoutBytes: input.maximumStdoutBytes,
        maximumStderrBytes: input.maximumStderrBytes,
        maximumOutputBytes: input.maximumOutputBytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

export function buildSeatbeltProfile(input: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
  network: boolean;
  profile: SandboxProfile;
  legacyFatRoot?: boolean;
}): string {
  const writes = input.readwritePaths
    .map((p) => `(allow file-write* (subpath ${JSON.stringify(resolve(p))}))`)
    .join('\n  ');
  const fat =
    input.profile === 'host-install' ||
    input.profile === 'ambient' ||
    input.legacyFatRoot === true;

  let reads: string;
  if (fat) {
    reads = '(allow file-read*)';
  } else if (input.readonlyPaths.length > 0) {
    reads = [
      ...packageExecRoRoots().map(
        (p) => `(allow file-read* (subpath ${JSON.stringify(p)}))`,
      ),
      ...input.readonlyPaths.map(
        (p) => `(allow file-read* (subpath ${JSON.stringify(resolve(p))}))`,
      ),
    ].join('\n  ');
  } else {
    reads = packageExecRoRoots()
      .map((p) => `(allow file-read* (subpath ${JSON.stringify(p)}))`)
      .join('\n  ');
  }

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
  if (platform() === 'linux' && findTrustedSandboxHelper('bwrap'))
    return createBwrapBackend();
  if (platform() === 'darwin' && findTrustedSandboxHelper('sandbox-exec'))
    return createSeatbeltBackend();
  return undefined;
}
