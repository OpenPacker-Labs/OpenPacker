import { resolve } from 'node:path';
import { SandboxBackendError } from './mock.js';
import { packageExecRoRoots } from './native.js';
import { sensitiveMaskDirectories } from '../paths.js';
import type { SandboxBackend, SandboxProfile } from '../types.js';

/**
 * macOS sandbox-exec (Seatbelt). Not a backend: it does not own a killable
 * process tree, so package-exec on macOS is MXC's. The profile is kept for
 * hosts that use it outside the package funnel.
 */

export function createSeatbeltBackend(): SandboxBackend {
  throw new SandboxBackendError(
    'UNAVAILABLE',
    'sandbox-exec does not own a killable process tree; use MXC on macOS',
  );
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
