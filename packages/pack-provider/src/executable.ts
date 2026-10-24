import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { ProviderError } from '@openpacker/adapter-core';
import { stableHandlePath } from '@openpacker/project-io';

/**
 * Immutable snapshot authority for an operator-approved standalone executable
 * (ADR 0038, reused for delegated adapter plugins by ADR 0039).
 *
 * Before execution the host copies bounded bytes from the no-follow approved
 * file into an unnamed O_TMPFILE snapshot, hashes the snapshot, and the
 * sandbox executes only the private snapshot handle. Unavailable unnamed
 * storage, non-Linux platforms, symlinks, and any identity change fail
 * closed; there is no named fallback a caller could be tricked into swapping.
 */

export const MAX_DELEGATED_EXECUTABLE_BYTES = 64 * 1_024 * 1_024;

/**
 * Error code for a host that cannot hold the snapshot at all. Not "unsafe
 * executable": the file may be fine, the platform cannot run it.
 */
export const UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM';

/**
 * Why a delegated executable cannot be snapshotted and run here, or undefined
 * when it can. The snapshot is an unnamed O_TMPFILE file run by its
 * /proc/self/fd path; macOS has neither (no unnamed files, `/dev/fd/N` is a
 * descriptor filesystem, ADR 0045) and Node cannot fexecve, so a named copy is
 * the only thing left and it is exactly the swappable path this refuses to
 * run. Said before the file is opened, not as a late "not a stable file".
 */
export function delegatedExecutionRefusal(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'linux') return undefined;
  const label =
    platform === 'darwin'
      ? 'macOS'
      : platform === 'win32'
        ? 'Windows'
        : platform;
  return (
    `Delegated provider executables need Linux: they are snapshotted into an unnamed O_TMPFILE file and run from ` +
    `its /proc/self/fd path, and ${label} has neither (Node cannot fexecve, and a named copy could be swapped ` +
    `between the check and the run). Run the delegated pack on a Linux host.`
  );
}
const LINUX_O_TMPFILE = 0x40_0000 | constants.O_DIRECTORY;

export interface DelegatedExecutableIdentity {
  path: string;
  digest: { algorithm: 'sha256'; value: string };
  device: bigint;
  inode: bigint;
  size: bigint;
  ctimeNanoseconds: bigint;
  mtimeNanoseconds: bigint;
}

export type InspectDelegatedExecutable = (
  path: string,
) => Promise<DelegatedExecutableIdentity>;

export interface DelegatedExecutableAuthority {
  identity: DelegatedExecutableIdentity;
  fd: number;
  close(): Promise<void>;
}

export type OpenDelegatedExecutableAuthority = (
  path: string,
) => Promise<DelegatedExecutableAuthority>;

export async function inspectDelegatedExecutable(
  path: string,
  openFile: typeof open = open,
): Promise<DelegatedExecutableIdentity> {
  const authority = await openDelegatedExecutable(path, openFile);
  try {
    return authority.identity;
  } finally {
    await authority.close();
  }
}

export async function openDelegatedExecutable(
  path: string,
  openFile: typeof open = open,
): Promise<DelegatedExecutableAuthority> {
  const unsupported = delegatedExecutionRefusal();
  if (unsupported !== undefined)
    throw new ProviderError(UNSUPPORTED_PLATFORM, unsupported);
  if (!isAbsolute(path)) unsafeExecutable(path);
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o111n) === 0n ||
    before.size > BigInt(MAX_DELEGATED_EXECUTABLE_BYTES)
  )
    unsafeExecutable(path);
  const source = await openFile(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let snapshot: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    const opened = await source.stat({ bigint: true });
    if (!sameExecutableMetadata(before, opened)) unsafeExecutable(path);
    const sourceHash = createHash('sha256');
    const buffer = new Uint8Array(64 * 1024);
    let offset = 0;
    const writer = await openFile(
      tmpdir(),
      LINUX_O_TMPFILE | constants.O_RDWR,
      0o700,
    );
    try {
      snapshot = await openFile(stableHandlePath(writer), constants.O_RDONLY);
      while (offset < Number(opened.size)) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.byteLength, Number(opened.size) - offset),
          offset,
        );
        if (bytesRead === 0) break;
        sourceHash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await writer.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          if (bytesWritten === 0) unsafeExecutable(path);
          written += bytesWritten;
        }
        offset += bytesRead;
      }
      await writer.sync();
      await writer.chmod(0o500);
    } finally {
      await writer.close();
    }
    const [after, namedAfter] = await Promise.all([
      source.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      BigInt(offset) !== opened.size ||
      !sameExecutableMetadata(opened, after) ||
      !sameExecutableMetadata(opened, namedAfter)
    )
      unsafeExecutable(path);
    const snapshotInfo = await snapshot.stat({ bigint: true });
    if (!snapshotInfo.isFile() || snapshotInfo.size !== opened.size)
      unsafeExecutable(path);
    const sourceDigest = sourceHash.digest('hex');
    const snapshotDigest = await hashOpenFile(snapshot, Number(opened.size));
    if (snapshotDigest !== sourceDigest) unsafeExecutable(path);
    return {
      identity: {
        path,
        digest: { algorithm: 'sha256', value: snapshotDigest },
        device: opened.dev,
        inode: opened.ino,
        size: opened.size,
        ctimeNanoseconds: timestampNanoseconds(opened, 'ctime'),
        mtimeNanoseconds: timestampNanoseconds(opened, 'mtime'),
      },
      fd: snapshot.fd,
      close: async () => await snapshot!.close(),
    };
  } catch (error) {
    await snapshot?.close().catch(() => undefined);
    throw error;
  } finally {
    await source.close().catch(() => undefined);
  }
}

/**
 * Fail closed when the approved executable at the same path is no longer the
 * file whose snapshot was taken — re-checked around every sandboxed run.
 */
export async function assertExecutableIdentity(
  expected: DelegatedExecutableIdentity,
  actual: DelegatedExecutableIdentity,
): Promise<void> {
  if (
    expected.path !== actual.path ||
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.size !== actual.size ||
    expected.ctimeNanoseconds !== actual.ctimeNanoseconds ||
    expected.mtimeNanoseconds !== actual.mtimeNanoseconds ||
    expected.digest.value !== actual.digest.value
  )
    unsafeExecutable(expected.path);
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = new Uint8Array(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, size - offset),
      offset,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('Executable snapshot was truncated');
  return hash.digest('hex');
}

function sameExecutableMetadata(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    timestampNanoseconds(left, 'ctime') ===
      timestampNanoseconds(right, 'ctime') &&
    timestampNanoseconds(left, 'mtime') === timestampNanoseconds(right, 'mtime')
  );
}

function timestampNanoseconds(
  info: Awaited<ReturnType<typeof lstat>>,
  kind: 'ctime' | 'mtime',
): bigint {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const milliseconds = `${kind}Ms` as 'ctimeMs' | 'mtimeMs';
  const value = info[milliseconds];
  return typeof value === 'bigint'
    ? value * 1_000_000n
    : BigInt(Math.trunc(value * 1_000_000));
}

function unsafeExecutable(path: string): never {
  throw new ProviderError(
    'AUTHORITY_NOT_DECLARED',
    `Delegated provider executable is not a stable approved regular file: ${path}`,
  );
}
