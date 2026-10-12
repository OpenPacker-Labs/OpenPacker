/**
 * Reading a workspace member's `package.json` for `opm run` (ADR 0053).
 *
 * Discovery has already refused every link on the way to a member, but it keeps
 * only the fields the dependency graph needs, and the scripts are not among
 * them. They are read again here, by path, so each component is checked again:
 * a member directory, or any directory above it, that is a symbolic link is
 * refused with its path, the file is opened without following a link and must
 * be a regular file under the size bound, and the directory is compared with
 * its real path once the file is read. That narrows a swap between discovery
 * and this read to the moment between the last two checks; closing it needs
 * the handle-relative walk discovery uses, and anyone who can win that race can
 * also rewrite the script they would be making `opm` read.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { RunError } from './run-error.js';
import {
  MAX_PACKAGE_JSON_BYTES,
  readPackageText,
  type PackageFile,
} from './run-package.js';

function refuseLink(path: string): RunError {
  return new RunError(
    'UNSAFE_PATH',
    `${path} is a symbolic link; workspace members are never read through one`,
  );
}

async function checkedStat(path: string, want: 'directory' | 'file') {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    // SAFETY: Node file-system errors carry a string `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) throw refuseLink(path);
  const right = want === 'directory' ? info.isDirectory() : info.isFile();
  if (!right)
    throw new RunError('INVALID_MANIFEST', `${path} is not a ${want}`);
  return info;
}

/**
 * The name, version and scripts of the member in `dir` (relative to `root`, with
 * `/` separators, `''` for the root). `root` is the canonical project root.
 * `undefined` when the member has no `package.json` any more.
 */
export async function readMemberPackage(
  root: string,
  dir: string,
): Promise<PackageFile | undefined> {
  let current = root;
  for (const segment of dir === '' ? [] : dir.split('/')) {
    current = join(current, segment);
    if ((await checkedStat(current, 'directory')) === undefined)
      return undefined;
  }
  const file = join(current, 'package.json');
  if ((await checkedStat(file, 'file')) === undefined) return undefined;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ELOOP') throw refuseLink(file);
    throw error;
  });
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new RunError('INVALID_MANIFEST', `${file} is not a regular file`);
    if (info.size > MAX_PACKAGE_JSON_BYTES)
      throw new RunError(
        'INVALID_MANIFEST',
        `${file} is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`,
      );
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  if ((await realpath(current)) !== current) throw refuseLink(current);
  return readPackageText(file, text);
}
