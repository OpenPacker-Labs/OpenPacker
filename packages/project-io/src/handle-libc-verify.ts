/**
 * Layouts that are checked before they are trusted.
 *
 * The `struct stat` and `struct dirent` tables are written from headers, and
 * the macOS ones had never run on a Mac when they were written. The first stat
 * and the first listing are compared with what Node says about the same
 * directory, and a difference names the field and dumps the raw bytes, rather
 * than surfacing later as a puzzling INPUT_CHANGED. The first link made is held
 * to the same standard in `handle-libc-link.ts`.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  type BigIntStats,
} from 'node:fs';
import { attempt, check, type LibcApi } from './handle-libc-api.js';
import { listEntries, nodeKind } from './handle-libc-list.js';
import { decodeStat, type DecodedStat } from './handle-libc-profile.js';
import { StableHandleError } from './handle-support.js';

/** A directory whose stat and listing are compared with Node's before they are trusted. */
const REFERENCE_DIRECTORY = '/';

export interface Verified {
  stat: boolean;
  dirent: boolean;
  /** symlinkat, readlinkat and fstatat agreed about the first link made. */
  link: boolean;
}

function statMismatches(libc: DecodedStat, node: BigIntStats): string[] {
  const rows: [string, bigint, bigint][] = [
    ['dev', libc.dev, node.dev],
    ['ino', libc.ino, node.ino],
    ['mode', libc.mode, node.mode],
    ['nlink', libc.nlink, node.nlink],
    ['uid', libc.uid, node.uid],
    ['gid', libc.gid, node.gid],
    ['size', libc.size, node.size],
    ['mtimeNs', libc.mtimeNs, node.mtimeNs],
    ['ctimeNs', libc.ctimeNs, node.ctimeNs],
  ];
  return rows
    .filter(([, mine, theirs]) => mine !== theirs)
    .map(([field, mine, theirs]) => `${field} libc=${mine} node=${theirs}`);
}

/**
 * Refuse to trust a `struct stat` layout Node does not agree with.
 *
 * The layout tables are written from headers, and the macOS one had never run
 * on a Mac when this was written. A wrong table would otherwise surface as a
 * puzzling INPUT_CHANGED far from here, so the first stat compares the
 * reference directory's decoded fields with `fs.fstat` of the same descriptor
 * and, on a difference, names the field and dumps the raw bytes.
 */
export function verifyStatLayout(api: LibcApi, verified: Verified): void {
  if (verified.stat) return;
  const { profile } = api;
  const reference = openSync(
    REFERENCE_DIRECTORY,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    let last = '';
    // A rare concurrent change to the reference between the two reads is retried.
    for (let round = 0; round < 3; round += 1) {
      const buffer = Buffer.alloc(profile.stat.bufferSize);
      check(
        attempt(api, () =>
          api.fstatat(reference, '.', buffer, profile.atSymlinkNoFollow),
        ),
        'fstatat',
        REFERENCE_DIRECTORY,
      );
      const mismatches = statMismatches(
        decodeStat(buffer, profile.stat),
        fstatSync(reference, { bigint: true }),
      );
      if (mismatches.length === 0) {
        verified.stat = true;
        return;
      }
      last = `${mismatches.join('; ')}; bytes ${buffer.subarray(0, 160).toString('hex')}`;
    }
    throw new StableHandleError(
      `libc struct stat layout "${profile.id}" disagrees with Node: ${last}`,
    );
  } finally {
    closeSync(reference);
  }
}

/** The `struct dirent` counterpart of verifyStatLayout. */
export function verifyDirentLayout(api: LibcApi, verified: Verified): void {
  if (verified.dirent) return;
  const reference = openSync(
    REFERENCE_DIRECTORY,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const mine = listEntries(api, reference, REFERENCE_DIRECTORY);
    const node = new Map(
      readdirSync(REFERENCE_DIRECTORY, { withFileTypes: true }).map((entry) => [
        entry.name,
        nodeKind(entry),
      ]),
    );
    const agrees =
      mine.length === node.size &&
      mine.every((entry) => {
        const other = node.get(entry.name);
        return (
          other !== undefined &&
          (other === entry.kind ||
            other === 'unknown' ||
            entry.kind === 'unknown')
        );
      });
    if (!agrees)
      throw new StableHandleError(
        `libc struct dirent layout "${api.profile.id}" disagrees with Node: libc ${JSON.stringify(
          mine.slice(0, 8),
        )} node ${JSON.stringify([...node].slice(0, 8))}`,
      );
    verified.dirent = true;
  } finally {
    closeSync(reference);
  }
}

/** `fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)` decoded, after the layout has been verified once. */
export function lstatRaw(
  api: LibcApi,
  verified: Verified,
  dirfd: number,
  name: string,
): DecodedStat {
  verifyStatLayout(api, verified);
  const { profile } = api;
  const buffer = Buffer.alloc(profile.stat.bufferSize);
  check(
    attempt(api, () =>
      api.fstatat(dirfd, name, buffer, profile.atSymlinkNoFollow),
    ),
    'lstat',
    name,
  );
  return decodeStat(buffer, profile.stat);
}
