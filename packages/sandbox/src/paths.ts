import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Credential directories masked inside native jails.
 *
 * We deliberately do **not** mask all of `/home` or `/Users`: interpreters
 * (nvm, fnm, mise) and toolchains often live under the user home, and hiding
 * the whole tree makes even benign package scripts unrunnable. Mask only the
 * directories a lifecycle script has no legitimate reason to read.
 *
 * Applied as tmpfs overlays *before* package RW binds so granted paths still win.
 */
export function sensitiveMaskDirectories(): string[] {
  const masks = new Set<string>([
    '/var/run/secrets',
    '/run/secrets',
    '/private/var/run/secrets',
    '/root/.ssh',
    '/root/.aws',
    '/root/.gnupg',
    '/root/.docker',
    '/root/.kube',
    '/root/.config/gh',
    '/root/.config/gcloud',
    '/root/.azure',
  ]);
  try {
    const home = homedir();
    if (home && isAbsolute(home)) {
      const h = resolve(home);
      for (const rel of [
        '.ssh',
        '.aws',
        '.gnupg',
        '.docker',
        '.kube',
        '.config/gh',
        '.config/gcloud',
        '.config/gh',
        '.azure',
        '.netrc',
      ]) {
        masks.add(join(h, rel));
      }
    }
  } catch {
    // ignore
  }
  return [...masks].sort();
}

/** Host credential files overlaid with an empty node so they cannot be read. */
export function sensitiveMaskFiles(): string[] {
  const files = new Set<string>([
    '/etc/shadow',
    '/etc/gshadow',
    '/etc/sudoers',
  ]);
  try {
    const home = homedir();
    if (home && isAbsolute(home)) {
      const h = resolve(home);
      for (const rel of ['.npmrc', '.netrc', '.git-credentials']) {
        files.add(join(h, rel));
      }
    }
  } catch {
    // ignore
  }
  return [...files].sort();
}

/**
 * Network CLIs masked under package-exec when the jail has no network grant.
 * Node itself can still open sockets; this removes the obvious host helpers.
 */
export function networkToolMaskFiles(): string[] {
  const names = [
    'curl',
    'wget',
    'nc',
    'ncat',
    'netcat',
    'ssh',
    'scp',
    'sftp',
    'rsync',
  ];
  const dirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) out.push(join(dir, name));
  }
  return out;
}

/**
 * Validate a jail grant path (read/write).
 *
 * Rejects empty, NUL, and path segments that are `..` before resolution so a
 * grant cannot smuggle a traversal through config. Absolute paths are allowed
 * (package caches often live under the user home).
 */
export function assertSafeJailPath(value: string, kind = 'path'): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new JailPathError(kind, 'path must be a non-empty string');
  if (value.includes('\0'))
    throw new JailPathError(kind, 'path must not contain NUL');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..'))
    throw new JailPathError(kind, 'path must not contain ".." segments');
  // Bind helpers follow symlinked ancestors. Refuse any alias rather than
  // letting an apparently package-local grant resolve to / or $HOME.
  const absolute = resolve(value);
  let existing = absolute;
  for (;;) {
    try {
      if (realpathSync.native(existing) !== existing)
        throw new JailPathError(kind, 'path must not contain symbolic links');
      break;
    } catch (error) {
      if (error instanceof JailPathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return absolute;
}

export function normalizeJailPaths(
  paths: readonly string[] | undefined,
  kind: string,
): string[] {
  if (!paths?.length) return [];
  const out: string[] = [];
  for (const path of paths) {
    out.push(assertSafeJailPath(path, kind));
  }
  // De-dupe while preserving order.
  return [...new Set(out)];
}

/**
 * Whether `candidate` is the same as or a descendant of `root`.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  if (base === target) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

export class JailPathError extends Error {
  readonly code = 'UNSAFE_JAIL_PATH';
  constructor(kind: string, detail: string) {
    super(`Invalid jail ${kind}: ${detail}`);
    this.name = 'JailPathError';
  }
}
