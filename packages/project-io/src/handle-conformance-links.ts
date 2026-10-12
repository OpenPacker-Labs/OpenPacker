/**
 * The workspace-member link scenarios of the handle conformance suite.
 *
 * Same contract as `handle-conformance.ts`: each line is an observation that
 * does not depend on a path, an inode or a timestamp, the /proc/self/fd
 * implementation on Linux recorded them, and the libc `*at()` implementation
 * (on glibc, and on a Mac against libSystem) must say exactly the same.
 */

import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  readlinkChild,
  symlinkChild,
  unlinkChild,
  type LinkOutcome,
  type LinkSite,
} from './handle-link.js';
import {
  lstatChild,
  openChild,
  readDirChildWithTypes,
  removeChild,
  renameChild,
} from './handle-path.js';

const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

const MEMBER = '../packages/pkg';

async function failureOf<T>(
  work: () => Promise<T>,
): Promise<NodeJS.ErrnoException | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    // SAFETY: the operations under test throw Error values with an optional errno code.
    return error as NodeJS.ErrnoException;
  }
}

async function codeOf<T>(work: () => Promise<T>): Promise<string> {
  const failure = await failureOf(work);
  return failure === undefined ? 'ok' : (failure.code ?? 'no-code');
}

/** ELOOP (O_NOFOLLOW on the last component) and ENOTDIR (O_DIRECTORY first) are both the refusal. */
async function refusal<T>(work: () => Promise<T>): Promise<string> {
  const code = await codeOf(work);
  return code === 'ELOOP' || code === 'ENOTDIR' ? 'refused' : code;
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

/** A project with a member at `packages/pkg` and an open `node_modules`. */
async function project(dir: string, name: string) {
  const root = join(dir, name);
  const modulesPath = join(root, 'node_modules');
  const memberPath = join(root, 'packages', 'pkg');
  await mkdir(modulesPath, { recursive: true });
  await mkdir(memberPath, { recursive: true });
  await writeFile(join(memberPath, 'index.js'), 'member');
  const site: LinkSite = { directory: 'node_modules', projectRoot: root };
  return {
    root,
    modulesPath,
    memberPath,
    site,
    modules: await open(modulesPath, DIRECTORY),
  };
}

/** Create, read, replace nothing, and remove without following. */
export async function links(dir: string): Promise<string[]> {
  const lines: string[] = [];
  const { root, modulesPath, memberPath, site, modules } = await project(
    dir,
    'links',
  );
  const memberFile = join(memberPath, 'index.js');
  try {
    const link = join(modulesPath, 'pkg');
    lines.push(
      `create: ${await symlinkChild(modules, 'pkg', MEMBER, site)}`,
      `text read back: ${await readlinkChild(modules, 'pkg', site)}`,
      `a link to the member: ${(await lstat(link)).isSymbolicLink()}, resolves to it: ${
        (await realpath(link)) === (await realpath(memberPath))
      }`,
      `create again: ${await symlinkChild(modules, 'pkg', MEMBER, site)}`,
    );
    const other = await failureOf(() =>
      symlinkChild(modules, 'pkg', '../packages/other', site),
    );
    lines.push(
      `create with another target: ${other?.code}`,
      `the link kept its target: ${await readlinkChild(modules, 'pkg', site)}`,
    );

    await writeFile(join(modulesPath, 'file'), 'keep');
    lines.push(
      `a file in the way: ${await codeOf(() => symlinkChild(modules, 'file', MEMBER, site))}, file intact ${
        (await readFile(join(modulesPath, 'file'), 'utf8')) === 'keep'
      }`,
    );
    await mkdir(join(modulesPath, 'folder'));
    await writeFile(join(modulesPath, 'folder', 'inner'), 'keep');
    lines.push(
      `a directory in the way: ${await codeOf(() => symlinkChild(modules, 'folder', MEMBER, site))}, directory intact ${
        (await readFile(join(modulesPath, 'folder', 'inner'), 'utf8')) ===
        'keep'
      }`,
      `read a file as a link: ${await codeOf(() => readlinkChild(modules, 'file', site))}`,
      `read a directory as a link: ${await codeOf(() => readlinkChild(modules, 'folder', site))}`,
      `read a missing name: ${await codeOf(() => readlinkChild(modules, 'missing', site))}`,
    );

    const seen = await lstatChild(modules, 'pkg');
    const typed = (await readDirChildWithTypes(modules)).find(
      (entry) => entry.name === 'pkg',
    );
    lines.push(
      `lstat of the link: symlink ${seen.isSymbolicLink()}, file ${seen.isFile()}, directory ${seen.isDirectory()}`,
      `the listing types it as a link: ${typed?.isSymbolicLink()}`,
      `open it with O_NOFOLLOW: ${await refusal(() => openChild(modules, 'pkg', constants.O_RDONLY | constants.O_NOFOLLOW))}`,
      `open it as a directory with O_NOFOLLOW: ${await refusal(() => openChild(modules, 'pkg', DIRECTORY))}`,
      `rename the link: ${await codeOf(() => renameChild(modules, 'pkg', 'moved'))}, still a link ${(await lstat(join(modulesPath, 'moved'))).isSymbolicLink()}`,
      `remove it with removeChild: ${await codeOf(() => removeChild(modules, 'moved', {}))}, member kept ${await exists(memberFile)}`,
    );

    await symlinkChild(modules, 'pkg', MEMBER, site);
    lines.push(
      `unlink: ${await codeOf(() => unlinkChild(modules, 'pkg'))}, member kept ${await exists(memberFile)}, link gone ${!(await exists(link))}`,
    );
    const notFile = await failureOf(() => unlinkChild(modules, 'file'));
    const notDirectory = await failureOf(() => unlinkChild(modules, 'folder'));
    lines.push(
      `unlink a regular file: ${notFile?.code}, file kept ${await exists(join(modulesPath, 'file'))}`,
      `unlink a directory: ${notDirectory?.code}, directory kept ${await exists(join(modulesPath, 'folder', 'inner'))}`,
      `unlink a missing name: ${await codeOf(() => unlinkChild(modules, 'missing'))}`,
    );

    // A package whose own node_modules holds a link, removed as a tree.
    const innerPath = join(modulesPath, 'host', 'node_modules');
    await mkdir(innerPath, { recursive: true });
    const inner = await open(innerPath, DIRECTORY);
    try {
      await symlinkChild(inner, 'inner', '../../../packages/pkg', {
        directory: 'node_modules/host/node_modules',
        projectRoot: root,
      });
    } finally {
      await inner.close();
    }
    lines.push(
      `remove a tree holding a link: ${await codeOf(() => removeChild(modules, 'host', { recursive: true }))}, tree gone ${!(await exists(join(modulesPath, 'host')))}, member kept ${await exists(memberFile)}`,
    );

    lines.push(
      `a dangling target: ${await symlinkChild(modules, 'ghost', '../packages/missing', site)}, resolves ${await stat(
        join(modulesPath, 'ghost'),
      ).then(
        () => 'yes',
        (error: NodeJS.ErrnoException) => error.code,
      )}`,
    );

    // The member directory is later replaced by a regular file.
    await symlinkChild(modules, 'pkg', MEMBER, site);
    await rename(memberPath, join(root, 'packages', 'gone'));
    await writeFile(memberPath, 'now a file');
    lines.push(
      `the member replaced by a file: create again ${await symlinkChild(modules, 'pkg', MEMBER, site)}, text ${await readlinkChild(modules, 'pkg', site)}, reads ${await readFile(link, 'utf8')}`,
      `unlink it: ${await codeOf(() => unlinkChild(modules, 'pkg'))}, the file kept ${(await readFile(memberPath, 'utf8')) === 'now a file'}`,
    );
  } finally {
    await modules.close();
  }
  return lines;
}

/** Every refusal, by the code it comes with. */
export async function linkRefusals(dir: string): Promise<string[]> {
  const { root, site, modules } = await project(dir, 'refusals');
  try {
    const targets = [
      '/etc',
      '',
      '../..',
      '../../x',
      'a\\b',
      '../packages/pkg/',
      '../a/../b',
      '../node_modules/x',
      '../.opm/store/x',
      'x\0y',
    ];
    const names = ['.bin', '.', '..', '@scope', 'a/b', 'a\\b', 'a\0b', ''];
    const places = ['', '.', '..', 'src', 'node_modules/.bin', '/node_modules'];
    const codes = async (
      attempts: readonly (() => Promise<LinkOutcome>)[],
    ): Promise<string> =>
      (await Promise.all(attempts.map((attempt) => codeOf(attempt)))).join(' ');
    const lines = [
      `targets: ${await codes(targets.map((target) => () => symlinkChild(modules, 'pkg', target, site)))}`,
      `names: ${await codes(names.map((name) => () => symlinkChild(modules, name, MEMBER, site)))}`,
      `places: ${await codes(
        places.map(
          (directory) => () =>
            symlinkChild(modules, 'pkg', MEMBER, {
              directory,
              projectRoot: root,
            }),
        ),
      )}`,
    ];
    lines.push(
      `nothing was created: ${(await readDirChildWithTypes(modules)).length === 0}`,
    );
    return lines;
  } finally {
    await modules.close();
  }
}

/** Two callers at once, and a directory whose pathname is swapped. */
export async function linkRaces(dir: string): Promise<string[]> {
  const lines: string[] = [];
  const { site, modules } = await project(dir, 'races');
  try {
    const same = await Promise.all(
      Array.from({ length: 20 }, () =>
        symlinkChild(modules, 'one', MEMBER, site),
      ),
    );
    lines.push(
      `20 callers, one target: ${same.filter((value) => value === 'created').length} created, ${same.filter((value) => value === 'unchanged').length} unchanged`,
    );

    const mixed = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        symlinkChild(
          modules,
          'two',
          index % 2 === 0 ? MEMBER : '../packages/other',
          site,
        ).then(
          (value) => value,
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ),
    );
    const winner = await readlinkChild(modules, 'two', site);
    lines.push(
      `20 callers, two targets: ${mixed.filter((value) => value === 'created').length} created, ${mixed.filter((value) => value === 'unchanged').length} unchanged, ${mixed.filter((value) => value === 'LINK_CONFLICT').length} conflicts`,
      `the link is one of the two: ${winner === MEMBER || winner === '../packages/other'}`,
    );
  } finally {
    await modules.close();
  }

  // A handle names the directory it opened, whatever the pathname now is.
  const swapped = await project(dir, 'swapped');
  try {
    const moved = join(swapped.root, 'moved-modules');
    const outside = join(swapped.root, 'outside');
    await mkdir(outside);
    await rename(swapped.modulesPath, moved);
    await symlink(outside, swapped.modulesPath);
    await symlinkChild(swapped.modules, 'pkg', MEMBER, swapped.site);
    lines.push(
      `made in the moved directory only: ${await exists(join(moved, 'pkg'))} ${!(await exists(join(outside, 'pkg')))}`,
      `read through the handle: ${await readlinkChild(swapped.modules, 'pkg', swapped.site)}`,
    );
    await unlinkChild(swapped.modules, 'pkg');
    lines.push(
      `unlinked from the moved directory only: ${!(await exists(join(moved, 'pkg')))}`,
    );
  } finally {
    await swapped.modules.close();
  }
  return lines;
}
