/**
 * Workspace-member links through `symlinkat` and `readlinkat`.
 *
 * The first link made is read back with `readlinkat` and `fstatat`
 * (`AT_SYMLINK_NOFOLLOW`) and must agree with the bytes given: a wrong argument
 * order or flag value shows up here, naming the call and the raw bytes, and
 * not later as a link that points somewhere else.
 */

import { attempt, check, type LibcApi } from './handle-libc-api.js';
import { entryKindOfMode } from './handle-libc-profile.js';
import { lstatRaw, type Verified } from './handle-libc-verify.js';
import { StableHandleError } from './handle-support.js';

/** Bytes a link target may take; Linux and macOS PATH_MAX are 4096 and 1024. */
const LINK_BUFFER_BYTES = 4096;

/** The text of the link `name` of `dirfd`; EINVAL when it is not a link. */
export function readLinkText(
  api: LibcApi,
  dirfd: number,
  name: string,
): string {
  const buffer = Buffer.alloc(LINK_BUFFER_BYTES);
  const length = check(
    attempt(api, () => api.readlinkat(dirfd, name, buffer, LINK_BUFFER_BYTES)),
    'readlink',
    name,
  );
  // readlinkat() does not terminate the text and does not say when it cut
  // it short: a full buffer might be a longer target, so it is not trusted.
  if (length >= LINK_BUFFER_BYTES)
    throw new StableHandleError(
      `readlinkat '${name}' filled its ${LINK_BUFFER_BYTES}-byte buffer; the target may be longer than it can be read`,
    );
  return buffer.toString('utf8', 0, length);
}

/** `symlinkat(target, dirfd, name)`, then the first-use check. EEXIST when the name is taken. */
export function makeLink(
  api: LibcApi,
  verified: Verified,
  dirfd: number,
  name: string,
  target: string,
): void {
  if (target.includes('\0'))
    throw new StableHandleError(
      `symlinkat target ${JSON.stringify(target)} contains a NUL`,
    );
  check(
    attempt(api, () => api.symlinkat(target, dirfd, name)),
    'symlink',
    target,
    name,
  );
  verifyLinkCalls(api, verified, dirfd, name, target);
}

function verifyLinkCalls(
  api: LibcApi,
  verified: Verified,
  dirfd: number,
  name: string,
  target: string,
): void {
  if (verified.link) return;
  const wanted = Buffer.from(target);
  const read = Buffer.alloc(LINK_BUFFER_BYTES);
  const length = check(
    attempt(api, () => api.readlinkat(dirfd, name, read, LINK_BUFFER_BYTES)),
    'readlink',
    name,
  );
  const seen = lstatRaw(api, verified, dirfd, name);
  const problems: string[] = [];
  if (!read.subarray(0, length).equals(wanted))
    problems.push(
      `readlinkat returned ${length} bytes ${read.subarray(0, length).toString('hex')} but symlinkat was given ${wanted.length} bytes ${wanted.toString('hex')}`,
    );
  if (entryKindOfMode(seen.mode) !== 'symlink')
    problems.push(
      `fstatat with AT_SYMLINK_NOFOLLOW (${api.profile.atSymlinkNoFollow}) reported mode 0o${seen.mode.toString(8)}, which is not a link`,
    );
  else if (seen.size !== BigInt(wanted.length))
    problems.push(
      `fstatat reported a link of ${seen.size} bytes, expected ${wanted.length}`,
    );
  if (problems.length > 0) {
    check(
      attempt(api, () => api.unlinkat(dirfd, name, 0)),
      'unlink',
      name,
    );
    throw new StableHandleError(
      `libc symlinkat/readlinkat "${api.profile.id}" disagree: ${problems.join('; ')}`,
    );
  }
  verified.link = true;
}
