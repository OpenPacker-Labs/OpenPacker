import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { release } from 'node:os';
import { delimiter, join } from 'node:path';
import type { HostFacts } from './requirements.js';
import type { HostPlatform } from './select.js';

const OS: Record<string, string> = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  netbsd: 'netbsd',
  sunos: 'illumos',
  android: 'android',
};

const ARCH: Record<string, string> = {
  x64: 'x86_64',
  arm64: 'aarch64',
  arm: 'armv7',
  riscv64: 'riscv64',
  ia32: 'i686',
  ppc64: 'powerpc64le',
  s390x: 's390x',
  loong64: 'loongarch64',
};

/** Everything host detection reads from the process, so tests can supply it. */
export interface RuntimeFacts {
  readonly platform: string;
  readonly arch: string;
  readonly glibcVersion?: string;
  readonly musl?: boolean;
  readonly kernelRelease: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directories the loader searches, when they are known. */
  readonly libraryDirectories?: readonly string[];
}

export interface DetectedHost {
  readonly platform: HostPlatform;
  readonly facts: HostFacts;
}

/** The only part of Node's diagnostic report this module reads. */
interface ReportHeader {
  readonly header?: { readonly glibcVersionRuntime?: string };
}

function readGlibc(): string | undefined {
  try {
    const report: ReportHeader | undefined = process.report?.getReport();
    return report?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

function hasMuslLoader(): boolean {
  return ['/lib', '/usr/lib'].some((directory) => {
    try {
      return readdirSync(directory).some((name) => name.startsWith('ld-musl-'));
    } catch {
      return false;
    }
  });
}

/** The directories `ld.so` searches: its defaults plus `ld.so.conf` and its includes. */
function loaderDirectories(env: RuntimeFacts['env']): string[] {
  const directories = new Set<string>(
    (env.LD_LIBRARY_PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry !== ''),
  );
  for (const entry of ['/lib', '/lib64', '/usr/lib', '/usr/lib64'])
    directories.add(entry);
  const read = (path: string, depth: number): void => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/u, '').trim();
      if (line === '') continue;
      if (line.startsWith('include ') && depth < 3) {
        const pattern = line.slice('include '.length).trim();
        const slash = pattern.lastIndexOf('/');
        const directory = slash === -1 ? '.' : pattern.slice(0, slash);
        const suffix = pattern.slice(slash + 1).replace('*', '');
        try {
          for (const name of readdirSync(directory).sort())
            if (name.endsWith(suffix)) read(join(directory, name), depth + 1);
        } catch {
          // an include that does not exist contributes nothing
        }
      } else if (line.startsWith('/')) directories.add(line);
    }
  };
  read('/etc/ld.so.conf', 0);
  return [...directories];
}

function runtime(): RuntimeFacts {
  const glibcVersion = process.platform === 'linux' ? readGlibc() : undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    ...(glibcVersion !== undefined && { glibcVersion }),
    ...(process.platform === 'linux' &&
      glibcVersion === undefined &&
      hasMuslLoader() && { musl: true }),
    kernelRelease: release(),
    env: process.env,
  };
}

/** Whether `name` is on PATH, without running it. */
function onPath(
  name: string,
  env: RuntimeFacts['env'],
  windows: boolean,
): boolean {
  const names = windows ? [name, `${name}.exe`] : [name];
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    for (const candidate of names) {
      const path = join(directory, candidate);
      try {
        if (existsSync(path) && statSync(path).isFile()) return true;
      } catch {
        // an unreadable PATH entry cannot supply the command
      }
    }
  }
  return false;
}

/**
 * Describe this machine in packslip's terms. Nothing is executed: a library is
 * looked for in the directories the loader is configured to search, and a
 * command on PATH. A version that would need running the command to learn is
 * unknown, and the specification makes an unknown check a warning, never a
 * refusal.
 */
export function detectHost(facts: RuntimeFacts = runtime()): DetectedHost {
  const os = OS[facts.platform] ?? facts.platform;
  const arch = ARCH[facts.arch] ?? facts.arch;
  const libc =
    os !== 'linux'
      ? undefined
      : facts.glibcVersion !== undefined
        ? 'gnu'
        : facts.musl === true
          ? 'musl'
          : undefined;
  const osVersion =
    os === 'linux' || os === 'windows' ? facts.kernelRelease : undefined;
  let directories: readonly string[] | undefined = facts.libraryDirectories;
  const hasLibrary =
    os === 'linux'
      ? (name: string): boolean => {
          directories ??= loaderDirectories(facts.env);
          // Multiarch layouts keep libraries one level down (…/x86_64-linux-gnu).
          return directories.some((directory) => {
            if (existsSync(join(directory, name))) return true;
            try {
              return readdirSync(directory, { withFileTypes: true }).some(
                (entry) =>
                  entry.isDirectory() &&
                  /-linux-/u.test(entry.name) &&
                  existsSync(join(directory, entry.name, name)),
              );
            } catch {
              return false;
            }
          });
        }
      : undefined;
  return {
    platform: { os, arch, ...(libc !== undefined && { libc }) },
    facts: {
      os,
      ...(osVersion !== undefined && { osVersion }),
      ...(facts.glibcVersion !== undefined && {
        glibcVersion: facts.glibcVersion,
      }),
      ...(hasLibrary !== undefined && { hasLibrary }),
      command: (name) => ({ found: onPath(name, facts.env, os === 'windows') }),
    },
  };
}
