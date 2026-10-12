/**
 * Workspace-member links on Windows: a directory junction, made relative to
 * the parent handle and published with one rename.
 *
 * Why a junction: a symbolic link needs a privilege (or Developer Mode) that a
 * person installing packages does not have, and a junction needs none. A member
 * is a directory, which is the one thing a junction can name. Its price is an
 * absolute target (`reparse-data.ts`), so a project moved on disk needs its
 * layout written again, as a relative link on other platforms does not.
 *
 * Why not one call: a reparse point is made by sending `FSCTL_SET_REPARSE_POINT`
 * to a handle of an *empty directory that already exists*. Created in place,
 * that leaves a moment at the final name when it is a plain empty directory and
 * not yet a link. So the directory is created under a name nobody looks for,
 * made into the junction through the handle that created it, and renamed to
 * the final name with `ReplaceIfExists` off, which fails if the name is taken.
 * Every step is relative to the parent handle (`RootDirectory`), never to a
 * path, and the name is either absent or a complete junction.
 *
 * What remains, stated: the staging name `.<name>.opm-link-<uuid>` is visible
 * between creation and the rename, as an empty directory and then as a
 * junction. A crash in that interval leaves it behind; it is a dot name no
 * layout lists, and the next write of the layout does not touch it.
 *
 * None of this has run on Windows at the time it was written; the Windows leg
 * of CI is the first thing that can show it (handle-windows-link.test.ts).
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import type { LinkSite } from './handle-link.js';
import {
  ANY_KIND,
  O_DIRECTORY,
  STATUS_SUCCESS,
  nt,
  ntStatus,
  removeChild,
  windowsOpenChild,
  windowsReadReparse,
  windowsRenameChild,
} from './handle-path.js';
import { StableHandleError } from './handle-support.js';
import {
  IO_REPARSE_TAG_MOUNT_POINT,
  decodeReparse,
  encodeMountPoint,
  junctionPath,
  ntSubstituteName,
  pathOfSubstituteName,
  relativeTargetOf,
  samePath,
  type ReparseData,
} from './reparse-data.js';

const FSCTL_SET_REPARSE_POINT = 0x000900a4;

/**
 * The five NT operations a junction is made and read with. The real ones are
 * below; a test supplies an in-memory directory with the same contract so the
 * order of operations and every cleanup path can be run on any platform.
 */
export interface NtLinkOps {
  /** Open a child of `directory`; `flags` as for `openChild`, plus `ANY_KIND`. */
  open(directory: FileHandle, name: string, flags: number): Promise<FileHandle>;
  /** The reparse data of an open handle, undefined when it is not a reparse point. */
  readReparse(fd: number): Buffer | undefined;
  /** FSCTL_SET_REPARSE_POINT on an open, empty directory: the NT status. */
  setReparse(fd: number, data: Buffer): number;
  /** Rename within `directory`; EEXIST for a taken name when `replace` is false. */
  rename(
    directory: FileHandle,
    from: string,
    to: string,
    replace: boolean,
  ): Promise<void>;
  /** Remove a child that may not be there; never recursive. */
  remove(directory: FileHandle, name: string): Promise<void>;
}

/** The operations against the real NT API. */
export const realNtLinkOps: NtLinkOps = {
  open: (directory, name, flags) => windowsOpenChild(directory, name, flags),
  readReparse: (fd) => windowsReadReparse(fd),
  setReparse: (fd, data) => {
    const api = nt();
    return ntStatus(
      api.NtFsControlFile(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ...([
          api.getOsFHandle(fd),
          null,
          null,
          null,
          Buffer.alloc(16),
          FSCTL_SET_REPARSE_POINT,
          data,
          data.length,
          Buffer.alloc(8),
          0,
        ] as never[]),
      ),
    );
  },
  rename: (directory, from, to, replace) =>
    windowsRenameChild(directory, from, to, replace),
  remove: (directory, name) => removeChild(directory, name, { force: true }),
};

/** Node-shaped, so `symlinkChild` and its callers read it like any other platform's. */
function ntError(code: string, syscall: string, path: string, message: string) {
  const error: NodeJS.ErrnoException = new Error(
    `${code}: ${message}, ${syscall} '${path}'`,
  );
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function requireAbsoluteRoot(site: LinkSite): void {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(site.projectRoot))
    throw new StableHandleError(
      `A junction is made from an absolute project root with a drive or a share; got ${JSON.stringify(site.projectRoot)}`,
    );
}

/** Junctions made and read through one set of operations. */
export class NtJunctions {
  /** The first junction made has been read back and agreed with what was sent. */
  #verified = false;

  constructor(private readonly ops: NtLinkOps) {}

  /**
   * What the system holds for `name`: the decoded reparse data, undefined for a
   * plain file or directory, ENOENT for nothing. The name is opened as itself
   * (`FILE_OPEN_REPARSE_POINT`) and never followed.
   */
  async inspect(
    directory: FileHandle,
    name: string,
  ): Promise<ReparseData | undefined> {
    const handle = await this.ops.open(
      directory,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | ANY_KIND,
    );
    try {
      const raw = this.ops.readReparse(handle.fd);
      return raw === undefined ? undefined : decodeReparse(raw);
    } finally {
      await handle.close();
    }
  }

  /**
   * The text of the junction at `name` as `create` was given it: relative to
   * the link's directory when `site` says where that is, absolute otherwise.
   * EINVAL when the name is not a link, as `readlink` says everywhere.
   */
  async read(
    directory: FileHandle,
    name: string,
    site?: LinkSite,
  ): Promise<string> {
    const data = await this.inspect(directory, name);
    if (data === undefined)
      throw ntError('EINVAL', 'readlink', name, 'invalid argument');
    // A symbolic link someone made with a relative text keeps it as written.
    if (data.relative) return data.substitute.split('\\').join('/');
    const absolute = pathOfSubstituteName(data.substitute);
    return site === undefined
      ? absolute
      : relativeTargetOf(site.projectRoot, site.directory, absolute);
  }

  /**
   * Make `name` a junction to `target` (relative to `site.directory`) in
   * `directory`. EEXIST when the name is taken; nothing is replaced.
   */
  async create(
    directory: FileHandle,
    name: string,
    target: string,
    site: LinkSite,
  ): Promise<void> {
    requireAbsoluteRoot(site);
    const absolute = junctionPath(site.projectRoot, site.directory, target);
    const buffer = encodeMountPoint(ntSubstituteName(absolute), absolute);
    const staging = `.${name}.opm-link-${randomUUID()}`;

    try {
      const made = await this.ops.open(
        directory,
        staging,
        constants.O_RDWR | O_DIRECTORY | constants.O_CREAT | constants.O_EXCL,
      );
      let status: number;
      try {
        status = this.ops.setReparse(made.fd, buffer);
      } finally {
        await made.close();
      }
      if (status !== STATUS_SUCCESS)
        throw new StableHandleError(
          `FSCTL_SET_REPARSE_POINT for ${JSON.stringify(absolute)} failed with status 0x${status.toString(16)}`,
        );
      await this.ops.rename(directory, staging, name, false);
    } catch (error) {
      await this.ops.remove(directory, staging).catch(() => undefined);
      throw error;
    }
    await this.verifyOnce(directory, name, absolute);
  }

  /**
   * The first junction made is read back through FSCTL_GET_REPARSE_POINT and
   * must be a mount point to the very path that was sent. If not, it is removed
   * and the error names the call and the raw names, before any layout relies
   * on it.
   */
  private async verifyOnce(
    directory: FileHandle,
    name: string,
    absolute: string,
  ): Promise<void> {
    if (this.#verified) return;
    const data = await this.inspect(directory, name);
    const problems: string[] = [];
    if (data === undefined) problems.push('it is not a reparse point');
    else {
      if (data.tag !== IO_REPARSE_TAG_MOUNT_POINT)
        problems.push(
          `its tag is 0x${data.tag.toString(16)}, not a mount point`,
        );
      if (!samePath(pathOfSubstituteName(data.substitute), absolute))
        problems.push(
          `its substitute name is ${JSON.stringify(data.substitute)}, expected ${JSON.stringify(ntSubstituteName(absolute))}`,
        );
    }
    if (problems.length > 0) {
      await this.ops.remove(directory, name).catch(() => undefined);
      throw new StableHandleError(
        `FSCTL_SET_REPARSE_POINT then FSCTL_GET_REPARSE_POINT disagree for ${JSON.stringify(absolute)}: ${problems.join('; ')}`,
      );
    }
    this.#verified = true;
  }
}

const junctions = new NtJunctions(realNtLinkOps);

export function inspectReparse(
  directory: FileHandle,
  name: string,
): Promise<ReparseData | undefined> {
  return junctions.inspect(directory, name);
}

export function readJunction(
  directory: FileHandle,
  name: string,
  site?: LinkSite,
): Promise<string> {
  return junctions.read(directory, name, site);
}

export function createJunction(
  directory: FileHandle,
  name: string,
  target: string,
  site: LinkSite,
): Promise<void> {
  return junctions.create(directory, name, target, site);
}
