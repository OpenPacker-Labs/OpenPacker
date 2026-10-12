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
  DELETE,
  O_DIRECTORY,
  STATUS_SUCCESS,
  nt,
  ntStatus,
  removeChild,
  throwNt,
  windowsDeleteOpened,
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
  /**
   * Open a child of `directory`; `flags` as for `openChild`, plus `ANY_KIND`,
   * and `access` any access rights beyond reading (`DELETE`, to remove it).
   */
  open(
    directory: FileHandle,
    name: string,
    flags: number,
    access?: number,
  ): Promise<FileHandle>;
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
  /** Mark the object behind an open handle (opened with `DELETE`) for deletion: the NT status. */
  deleteOpened(fd: number): number;
}

/** The operations against the real NT API. */
export const realNtLinkOps: NtLinkOps = {
  open: (directory, name, flags, access) =>
    windowsOpenChild(directory, name, flags, undefined, access),
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
  deleteOpened: (fd) => windowsDeleteOpened(fd),
};

/** What `NtJunctions.unlink` found at the name, and did. */
export type UnlinkResult =
  | { kind: 'removed' }
  | { kind: 'not-a-link' }
  | { kind: 'other-target'; text: string };

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

/**
 * The text a link would have been given: relative to the link's directory when
 * `site` says where that is, absolute otherwise. A symbolic link someone made
 * with a relative text keeps it as written.
 */
function textOf(data: ReparseData, site?: LinkSite): string {
  if (data.relative) return data.substitute.split('\\').join('/');
  const absolute = pathOfSubstituteName(data.substitute);
  return site === undefined
    ? absolute
    : relativeTargetOf(site.projectRoot, site.directory, absolute);
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
    return textOf(data, site);
  }

  /**
   * Remove the junction at `name`, and nothing else. The name is opened as
   * itself with `DELETE` access, its reparse data is read from that handle, and
   * the object that handle holds is the one marked for deletion: a mount point
   * or a symbolic link goes, and anything else (a file, a plain directory, some
   * other reparse point) is `not-a-link` and is left. When `expected` is given
   * the link's text must be exactly that, else it is `other-target` and left.
   * Nothing is looked at by name between the look and the removal, so there is
   * no window for the name to change in.
   */
  async unlink(
    directory: FileHandle,
    name: string,
    expected?: { target: string; site: LinkSite },
  ): Promise<UnlinkResult> {
    const handle = await this.ops.open(
      directory,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | ANY_KIND,
      DELETE,
    );
    try {
      const raw = this.ops.readReparse(handle.fd);
      const data = raw === undefined ? undefined : decodeReparse(raw);
      if (data === undefined) return { kind: 'not-a-link' };
      if (expected !== undefined) {
        const text = textOf(data, expected.site);
        if (text !== expected.target) return { kind: 'other-target', text };
      }
      const status = this.ops.deleteOpened(handle.fd);
      if (status !== STATUS_SUCCESS) throwNt(status, name);
      return { kind: 'removed' };
    } finally {
      await handle.close();
    }
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

export function unlinkJunction(
  directory: FileHandle,
  name: string,
  expected?: { target: string; site: LinkSite },
): Promise<UnlinkResult> {
  return junctions.unlink(directory, name, expected);
}

export function createJunction(
  directory: FileHandle,
  name: string,
  target: string,
  site: LinkSite,
): Promise<void> {
  return junctions.create(directory, name, target, site);
}
