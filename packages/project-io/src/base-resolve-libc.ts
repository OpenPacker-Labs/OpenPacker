/**
 * The resolution of a base through the C library's `*at()` calls: macOS, where
 * `/dev/fd/N/child` names nothing (ADR 0045). Each look, open and read is
 * relative to the open directory before it, as on Linux through
 * `/proc/self/fd/N`, and the real path is the one the system gives the last
 * descriptor (`fcntl(F_GETPATH)`). The glibc profile runs the same code on
 * Linux, where `/proc/self/fd/N` stands in for F_GETPATH.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readlinkSync,
} from 'node:fs';
import type { DirectoryOps, Inspected } from './base-resolve.js';
import { attempt, openFd, type LibcApi } from './handle-libc-api.js';
import { readLinkText } from './handle-libc-link.js';
import { entryKindOfMode, type LibcAtProfile } from './handle-libc-profile.js';
import { lstatRaw, type Verified } from './handle-libc-verify.js';
import { bindProfile } from './handle-libc.js';

/** MAXPATHLEN on macOS: what F_GETPATH fills at most. */
const PATH_BUFFER_BYTES = 1024;

function kindOf(mode: bigint): Inspected['kind'] {
  const kind = entryKindOfMode(mode);
  if (kind === 'symlink') return 'link';
  return kind === 'directory' ? 'directory' : 'other';
}

/** The resolution's calls through `profile`'s C library; with `bindNow`, bound here (and throwing here) rather than at the first call. */
export function libcDirectoryOps(
  profile: LibcAtProfile,
  options: { bindNow?: boolean } = {},
): DirectoryOps {
  let bound: LibcApi | undefined =
    options.bindNow === true ? bindProfile(profile) : undefined;
  const verified: Verified = { stat: false, dirent: false, link: false };
  const api = (): LibcApi => (bound ??= bindProfile(profile));
  return {
    id: `libc-${profile.id}`,
    openRoot: (root) =>
      openSync(root, constants.O_RDONLY | constants.O_DIRECTORY),
    inspectAt(fd, name) {
      try {
        const info = lstatRaw(api(), verified, fd, name);
        return {
          kind: kindOf(info.mode),
          dev: info.dev,
          ino: info.ino,
          uid: info.uid,
          mode: info.mode,
        };
      } catch {
        return undefined;
      }
    },
    openDirectoryAt(fd, name) {
      try {
        return openFd(
          api(),
          fd,
          name,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
          'open',
          name,
        );
      } catch {
        return undefined;
      }
    },
    readlinkAt: (fd, name) => readLinkText(api(), fd, name),
    inspect(fd) {
      const info = fstatSync(fd, { bigint: true });
      return {
        kind: kindOf(info.mode),
        dev: info.dev,
        ino: info.ino,
        uid: info.uid,
        mode: info.mode,
      };
    },
    pathOf(fd) {
      if (profile.fGetPath === undefined) {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          return undefined;
        }
      }
      const command = profile.fGetPath;
      const buffer = Buffer.alloc(PATH_BUFFER_BYTES);
      const outcome = attempt(api(), () =>
        api().fcntlPath(fd, command, buffer),
      );
      if (outcome.result < 0) return undefined;
      const end = buffer.indexOf(0);
      const path = buffer.toString('utf8', 0, end < 0 ? buffer.length : end);
      return path.startsWith('/') ? path : undefined;
    },
    close: (fd) => closeSync(fd),
  };
}
