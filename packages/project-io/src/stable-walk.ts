/**
 * The one stable walk every no-follow directory opener goes through, and the
 * opening of a private root that a caller judges before it is taken.
 *
 * A walk opens the real path of the base its path lies under from the file
 * system's root, one `O_NOFOLLOW` component at a time, checks that what it
 * reached there is the directory the base was resolved to, and goes on below
 * it the same way, making what is missing where it is asked to. Before any of
 * that, the base must still lead where it did (`walkPlan`): a base retargeted
 * since is `INPUT_CHANGED` and nothing is made (ADR 0034, trusted bases).
 */

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve, sep } from 'node:path';
import { resolverOps, sameIdentity, type Identity } from './base-resolve.js';
import { O_DIRECTORY, mkdirChild, openChild } from './handle-path.js';
import { ProjectIoError } from './index.js';
import {
  resolveForWalk,
  takeOpened,
  walkPlan,
  type BaseChooser,
} from './trusted-base.js';

export interface WalkOptions {
  /** Make each missing directory below the base (`mkdir -p`). */
  create?: boolean;
  /** The mode a directory the walk makes is given, through its handle (past the umask). */
  createMode?: number;
  /** Let the last component be a regular file as well as a directory. */
  lastMayBeFile?: boolean;
  /** The error for a component that is not a directory (or, last, a file where one is allowed). */
  kindError?: (part: string, last: boolean) => Error;
}

function notADirectory(part: string): Error {
  const error: NodeJS.ErrnoException = new Error(
    `ENOTDIR: not a directory, open '${part}'`,
  );
  error.code = 'ENOTDIR';
  return error;
}

function differs(path: string): ProjectIoError {
  return new ProjectIoError(
    'INPUT_CHANGED',
    path,
    `The directory ${path} lies in was changed while opm was using it`,
  );
}

/**
 * Walk to `target` from its root, `baseDepth` components of it being the
 * base's own, which must end at `baseIdentity`.
 */
async function walkFrom(
  path: string,
  target: string,
  baseDepth: number,
  baseIdentity: Identity | undefined,
  options: WalkOptions,
): Promise<FileHandle> {
  const root = parse(target).root;
  let handle = await open(
    root,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const parts = relative(root, target).split(sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      let made = false;
      if (options.create === true && index >= baseDepth)
        made = await mkdirChild(handle, part).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
            return false;
          },
        );
      const fileAllowed = last && options.lastMayBeFile === true;
      const next = await openChild(
        handle,
        part,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          // A file is opened non-blocking so a FIFO named last cannot hold
          // the open; it is refused by the kind check below.
          (fileAllowed ? constants.O_NONBLOCK : O_DIRECTORY),
      );
      await handle.close();
      handle = next;
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() && !(fileAllowed && info.isFile()))
        throw (options.kindError ?? notADirectory)(part, last);
      if (
        made &&
        options.createMode !== undefined &&
        process.platform !== 'win32'
      )
        await handle.chmod(options.createMode);
      if (
        index + 1 === baseDepth &&
        baseIdentity !== undefined &&
        !sameIdentity(info, baseIdentity)
      )
        throw differs(path);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Open `path`, one `O_NOFOLLOW` component at a time from the real path of the
 * base it lies under (`trusted-base.ts`). The caller closes the handle.
 */
export async function walkStable(
  path: string,
  options: WalkOptions = {},
): Promise<FileHandle> {
  const plan = walkPlan(path);
  return walkFrom(
    path,
    plan.target,
    plan.baseDepth,
    plan.baseIdentity,
    options,
  );
}

/** A private root opened and not yet taken: its caller judges `handle`, then takes it. */
export interface RootOpening {
  readonly handle: FileHandle;
  /** Take the root as a base on `chosenBy`'s word, as it was opened; its real path. */
  take(chosenBy: BaseChooser): string;
}

/**
 * Open the directory `path` names, making it and what is missing on the way
 * (mode 0700) with `create`, for a caller to judge before it is taken as a
 * base (`ensurePrivateRoot` in opm-project). The way to it is resolved as a
 * base is (`base-resolve.ts`), so no link in a fence and none another user put
 * in a sticky directory is followed; with `lastMayBeLink` false the last
 * component is made and opened relative to its parent's handle with
 * `O_NOFOLLOW`, so a link there, whenever it appeared, is refused (ELOOP).
 * What is taken is the directory opened, and nothing is resolved again.
 */
export async function openRootDirectory(
  path: string,
  options: { create: boolean; lastMayBeLink: boolean },
): Promise<RootOpening> {
  const lexical = resolve(path);
  const way = resolveForWalk(
    options.lastMayBeLink ? lexical : dirname(lexical),
  );
  let handle = await walkFrom(
    lexical,
    way.real,
    way.reached.depth,
    way.reached.identity,
    { create: options.create, createMode: 0o700 },
  );
  if (!options.lastMayBeLink) {
    const name = basename(lexical);
    try {
      let made = false;
      if (options.create)
        made = await mkdirChild(handle, name).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
            return false;
          },
        );
      const root = await openChild(
        handle,
        name,
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (made && process.platform !== 'win32')
        await root.chmod(0o700).catch(async (error: unknown) => {
          await root.close();
          throw error;
        });
      await handle.close();
      handle = root;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  const opened = handle;
  const info = await opened.stat({ bigint: true });
  const real =
    resolverOps().pathOf(opened.fd) ??
    (options.lastMayBeLink ? way.real : resolve(way.real, basename(lexical)));
  return {
    handle: opened,
    take: (chosenBy) =>
      takeOpened(
        lexical,
        {
          real,
          identity: { dev: info.dev, ino: info.ino },
          linkAncestors: way.linkAncestors,
        },
        chosenBy,
      ),
  };
}
