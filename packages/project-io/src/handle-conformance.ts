/**
 * Scenarios that pin what a handle-relative backend must do, as transcripts.
 *
 * Each scenario drives the public child operations against a scratch directory
 * and returns one line per observation. The same scenarios run against the
 * /proc/self/fd implementation, the libc `*at()` implementation bound to glibc
 * (both on Linux, where their transcripts must be equal) and, on a Mac, the
 * shipping libSystem one, whose transcript must equal the one Linux recorded.
 * Nothing here depends on a path, an inode number or a timestamp, only on
 * behavior, so a transcript is the same wherever it is produced.
 */

import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join, parse, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  lstatChild,
  mkdirChild,
  mkdtempChild,
  openChild,
  readDirChild,
  readDirChildWithTypes,
  removeChild,
  renameChild,
} from './handle-path.js';

const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

async function done<T>(work: Promise<T>): Promise<void> {
  await work;
}

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

/** `ok`, or the error code the operation failed with. */
async function outcome<T>(work: () => Promise<T>): Promise<string> {
  const failure = await failureOf(work);
  return failure === undefined ? 'ok' : (failure.code ?? 'no-code');
}

/**
 * Refusing a symlink may surface as ELOOP (O_NOFOLLOW on the final component)
 * or ENOTDIR (O_DIRECTORY checked first); both are the refusal callers expect.
 */
async function refusal<T>(work: () => Promise<T>): Promise<string> {
  const code = await outcome(work);
  return code === 'ELOOP' || code === 'ENOTDIR' ? 'refused' : code;
}

/** `rename` onto a non-empty directory is ENOTEMPTY or EEXIST depending on the OS. */
async function notEmpty<T>(work: () => Promise<T>): Promise<string> {
  const code = await outcome(work);
  return code === 'ENOTEMPTY' || code === 'EEXIST' ? 'not-empty' : code;
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

async function withDirectory<T>(
  path: string,
  run: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  await mkdir(path, { recursive: true });
  const handle = await open(path, DIRECTORY);
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

type Scenario = (dir: string) => Promise<string[]>;

/** mkdir -p style walk from the filesystem root, as openStableDirectory does. */
const walk: Scenario = async (dir) => {
  const lines: string[] = [];
  const target = join(dir, 'w', 'x', 'y', 'z');
  const root = parse(target).root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (const round of ['first', 'second']) {
    let handle = await open(root, DIRECTORY);
    try {
      for (const part of parts) {
        const made = await outcome(() => mkdirChild(handle, part));
        if (part === 'w')
          lines.push(`${round} walk, mkdir of the first level: ${made}`);
        const next = await openChild(handle, part, DIRECTORY);
        await handle.close();
        handle = next;
      }
      const opened = await handle.stat({ bigint: true });
      const named = await lstat(target, { bigint: true });
      lines.push(
        `${round} walk reaches the target: ${
          opened.ino === named.ino && opened.dev === named.dev
        }, through more than three levels: ${parts.length > 3}`,
      );
    } finally {
      await handle.close();
    }
  }
  return lines;
};

const files: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'files');
  await withDirectory(base, async (parent) => {
    const create =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW;
    const file = await openChild(parent, 'created', create, 0o600);
    await file.writeFile('hello');
    await file.sync();
    await file.chmod(0o640);
    const info = await file.stat({ bigint: true });
    await file.close();
    await file.close();
    lines.push(`created size ${info.size}, isFile ${info.isFile()}`);
    lines.push(
      `chmod applied: ${((await stat(join(base, 'created'))).mode & 0o777).toString(8)}`,
    );
    lines.push(
      `created content: ${await readFile(join(base, 'created'), 'utf8')}`,
    );
    lines.push(
      `exclusive create again: ${await outcome(() => openChild(parent, 'created', create, 0o600))}`,
    );

    const umask = process.umask();
    const plain = await openChild(
      parent,
      'plain',
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o666,
    );
    await plain.close();
    lines.push(
      `mode honours umask: ${
        ((await stat(join(base, 'plain'))).mode & 0o777) === (0o666 & ~umask)
      }`,
    );

    const reader = await openChild(parent, 'created', constants.O_RDONLY);
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await reader.read(buffer, 0, 5, 0);
    await reader.close();
    lines.push(`read back ${bytesRead} bytes: ${buffer.toString()}`);

    await symlink(join(base, 'created'), join(base, 'link'));
    await mkdir(join(base, 'folder'));
    await symlink(join(base, 'folder'), join(base, 'folder-link'));
    lines.push(
      `open symlink with O_NOFOLLOW: ${await refusal(() =>
        openChild(parent, 'link', constants.O_RDONLY | constants.O_NOFOLLOW),
      )}`,
    );
    lines.push(
      `open symlinked directory: ${await refusal(() => openChild(parent, 'folder-link', DIRECTORY))}`,
    );
    lines.push(
      `open missing: ${await outcome(() => openChild(parent, 'missing', constants.O_RDONLY))}`,
    );
    lines.push(
      `open file as directory: ${await outcome(() =>
        openChild(
          parent,
          'created',
          constants.O_RDONLY | constants.O_DIRECTORY,
        ),
      )}`,
    );
    lines.push(
      `open directory for writing: ${await outcome(() =>
        openChild(parent, 'folder', constants.O_WRONLY),
      )}`,
    );
    lines.push(
      `open directory read-only: ${await outcome(async () =>
        (await openChild(parent, 'folder', DIRECTORY)).close(),
      )}`,
    );
    lines.push(
      `open under a file handle: ${await outcome(async () => {
        const regular = await openChild(parent, 'created', constants.O_RDONLY);
        try {
          await openChild(regular, 'x', constants.O_RDONLY);
        } finally {
          await regular.close();
        }
      })}`,
    );
  });
  return lines;
};

const stats: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'stats');
  await withDirectory(base, async (parent) => {
    await writeFile(join(base, 'file'), 'four');
    await mkdir(join(base, 'folder'));
    await symlink('file', join(base, 'link'));
    for (const name of ['file', 'folder', 'link']) {
      const child = await lstatChild(parent, name);
      const node = await lstat(join(base, name), { bigint: true });
      lines.push(
        `${name}: file ${child.isFile()}, directory ${child.isDirectory()}, symlink ${child.isSymbolicLink()}, ` +
          `fifo ${child.isFIFO()}, matches lstat ${
            child.dev === node.dev &&
            child.ino === node.ino &&
            child.mode === node.mode &&
            child.nlink === node.nlink &&
            child.uid === node.uid &&
            child.gid === node.gid &&
            child.size === node.size &&
            child.mtimeNs === node.mtimeNs &&
            child.ctimeNs === node.ctimeNs &&
            child.mtimeMs === node.mtimeMs &&
            child.mtime.getTime() === node.mtime.getTime()
          }`,
      );
    }
    const file = await lstatChild(parent, 'file');
    const link = await lstatChild(parent, 'link');
    lines.push(`sizes: file ${file.size}, symlink ${link.size}`);
    const opened = await (async () => {
      const handle = await openChild(parent, 'file', constants.O_RDONLY);
      try {
        return await handle.stat({ bigint: true });
      } finally {
        await handle.close();
      }
    })();
    lines.push(
      `agrees with fstat of the open file: ${opened.dev === file.dev && opened.ino === file.ino}`,
    );
    lines.push(
      `lstat missing: ${await outcome(() => lstatChild(parent, 'missing'))}`,
    );
  });
  return lines;
};

const renames: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'renames');
  await withDirectory(base, async (parent) => {
    await writeFile(join(base, 'a'), 'A');
    await writeFile(join(base, 'b'), 'B');
    lines.push(
      `rename a to c: ${await outcome(() => renameChild(parent, 'a', 'c'))}`,
    );
    lines.push(
      `a is gone, c holds A: ${!(await exists(join(base, 'a')))} ${await readFile(join(base, 'c'), 'utf8')}`,
    );
    lines.push(
      `rename c over b: ${await outcome(() => renameChild(parent, 'c', 'b'))}`,
    );
    lines.push(`b now holds: ${await readFile(join(base, 'b'), 'utf8')}`);
    lines.push(
      `rename missing: ${await outcome(() => renameChild(parent, 'missing', 'x'))}`,
    );
    await mkdir(join(base, 'dir1'));
    await mkdir(join(base, 'dir2'));
    await writeFile(join(base, 'dir2', 'inner'), '');
    lines.push(
      `rename onto a non-empty directory: ${await notEmpty(() => renameChild(parent, 'dir1', 'dir2'))}`,
    );
    lines.push(
      `rename onto an empty directory: ${await outcome(() => renameChild(parent, 'dir2', 'dir1'))}`,
    );
    await symlink(join(base, 'b'), join(base, 'ln'));
    lines.push(
      `rename a symlink: ${await outcome(() => renameChild(parent, 'ln', 'ln2'))}`,
    );
    lines.push(
      `symlink moved intact, target untouched: ${
        (await lstat(join(base, 'ln2'))).isSymbolicLink() &&
        (await readFile(join(base, 'b'), 'utf8')) === 'A'
      }`,
    );
  });
  return lines;
};

const removals: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'removals');
  const outside = join(dir, 'removals-outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'sentinel'), 'keep');
  await withDirectory(base, async (parent) => {
    await writeFile(join(base, 'file'), 'x');
    lines.push(
      `remove file: ${await outcome(() => removeChild(parent, 'file'))}`,
    );
    lines.push(`file is gone: ${!(await exists(join(base, 'file')))}`);
    lines.push(
      `remove missing: ${await outcome(() => removeChild(parent, 'file'))}`,
    );
    lines.push(
      `remove missing with force: ${await outcome(() => removeChild(parent, 'file', { force: true }))}`,
    );
    await mkdir(join(base, 'folder'));
    const refused = await failureOf(() => removeChild(parent, 'folder'));
    lines.push(
      `remove directory without recursive: ${refused?.code} ${refused?.syscall}`,
    );
    lines.push(`directory survived: ${await exists(join(base, 'folder'))}`);

    await mkdir(join(base, 'tree', 'a', 'b'), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      await writeFile(join(base, 'tree', 'a', 'b', `f${i}`), 'x');
      await writeFile(join(base, 'tree', 'a', `g${i}`), 'x');
    }
    await symlink(outside, join(base, 'tree', 'a', 'escape'));
    await symlink(join(outside, 'sentinel'), join(base, 'tree', 'file-escape'));
    lines.push(
      `remove a tree: ${await outcome(() => removeChild(parent, 'tree', { recursive: true }))}`,
    );
    lines.push(`tree is gone: ${!(await exists(join(base, 'tree')))}`);
    lines.push(
      `links inside the tree were not followed: ${await readFile(join(outside, 'sentinel'), 'utf8')}`,
    );

    await symlink(outside, join(base, 'top-link'));
    lines.push(
      `remove a symlinked directory recursively: ${await outcome(() =>
        removeChild(parent, 'top-link', { recursive: true, force: true }),
      )}`,
    );
    lines.push(
      `its target survived: ${await exists(join(outside, 'sentinel'))}, link gone ${!(await exists(join(base, 'top-link')))}`,
    );
    lines.push(
      `recursive on a plain file: ${await outcome(async () => {
        await writeFile(join(base, 'plain'), 'x');
        await removeChild(parent, 'plain', { recursive: true });
      })}`,
    );
    lines.push(
      `recursive and forced on nothing: ${await outcome(() =>
        removeChild(parent, 'nothing', { recursive: true, force: true }),
      )}`,
    );
    lines.push(
      `recursive on nothing: ${await outcome(() => removeChild(parent, 'nothing', { recursive: true }))}`,
    );
  });
  return lines;
};

async function describeDirectory(path: string): Promise<string> {
  return (await readdir(path, { withFileTypes: true }))
    .map((entry) => {
      const kind = entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFIFO()
            ? 'fifo'
            : entry.isFile()
              ? 'file'
              : 'other';
      return `${entry.name}:${kind}`;
    })
    .join(' ');
}

const listings: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'listings');
  await withDirectory(base, async (parent) => {
    for (const name of [
      'b',
      'a',
      'Zed',
      '_z',
      'é',
      '日本語',
      'emoji-😀',
      'with space',
    ]) {
      await writeFile(join(base, name), '');
    }
    await mkdir(join(base, '0dir'));
    await symlink('a', join(base, 'link'));
    execFileSync('mkfifo', [join(base, 'pipe')]);
    const expected = await describeDirectory(base);
    const names = await readDirChild(parent);
    lines.push(
      `names equal Node's readdir: ${names.join('|') === (await readdir(base)).join('|')}`,
    );
    const typed = await readDirChildWithTypes(parent);
    const mine = typed
      .map((entry) => {
        const kind = entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : entry.isFIFO()
              ? 'fifo'
              : entry.isFile()
                ? 'file'
                : 'other';
        return `${entry.name}:${kind}`;
      })
      .join(' ');
    lines.push(`typed entries equal Node's: ${mine === expected}`);
    lines.push(
      `typed ASCII entries: ${mine
        .split(' ')
        .filter((entry) => /^[\x20-\x7e]+$/u.test(entry))
        .join(' ')}`,
    );
    lines.push(
      `listing twice agrees: ${(await readDirChild(parent)).join('|') === names.join('|')}`,
    );

    for (let i = 0; i < 1500; i += 1)
      await writeFile(join(base, `bulk-${String(i).padStart(4, '0')}`), '');
    const many = await readDirChild(parent);
    lines.push(
      `1500 more entries listed in full: ${many.join('|') === (await readdir(base)).join('|')} (${many.length})`,
    );

    await mkdir(join(base, 'empty'));
    const empty = await withDirectory(join(base, 'empty'), (handle) =>
      readDirChild(handle),
    );
    lines.push(`empty directory lists ${empty.length} entries`);
    lines.push(
      `list a regular file: ${await outcome(async () => {
        const file = await openChild(parent, 'a', constants.O_RDONLY);
        try {
          await readDirChild(file);
        } finally {
          await file.close();
        }
      })}`,
    );
  });
  return lines;
};

/** A handle names the directory it opened, whatever happens to the pathname. */
const swapped: Scenario = async (dir) => {
  const lines: string[] = [];
  const authorized = join(dir, 'swap', 'authorized');
  const moved = join(dir, 'swap', 'moved');
  const outside = join(dir, 'swap', 'outside');
  await mkdir(authorized, { recursive: true });
  await mkdir(outside);
  await writeFile(join(authorized, 'value'), 'authorized');
  await writeFile(join(outside, 'value'), 'outside');
  const handle = await open(authorized, DIRECTORY);
  try {
    await rename(authorized, moved);
    await symlink(outside, authorized);
    const file = await openChild(
      handle,
      'value',
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const buffer = Buffer.alloc(10);
    const { bytesRead } = await file.read(buffer, 0, 10, 0);
    await file.close();
    lines.push(
      `read through the handle: ${buffer.subarray(0, bytesRead).toString()}`,
    );
    await mkdirChild(handle, 'fresh');
    lines.push(
      `created in the moved directory only: ${await exists(join(moved, 'fresh'))} ${!(await exists(join(outside, 'fresh')))}`,
    );
    await removeChild(handle, 'value');
    lines.push(
      `removed from the moved directory only: ${!(await exists(join(moved, 'value')))} ${await exists(join(outside, 'value'))}`,
    );
    lines.push(
      `listing follows the handle: ${(await readDirChild(handle)).join('|')}`,
    );
  } finally {
    await handle.close();
  }
  return lines;
};

const concurrency: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'concurrency');
  await withDirectory(base, async (parent) => {
    const made = await Promise.all(
      Array.from({ length: 50 }, () => mkdtempChild(parent, 'tmp-')),
    );
    lines.push(
      `50 concurrent mkdtemp are unique: ${new Set(made).size === 50}`,
    );
    await Promise.all(
      made.map((name, index) =>
        writeFile(join(base, name, 'f'), String(index)),
      ),
    );
    await Promise.all(
      made.map((name) => renameChild(parent, name, `${name}-renamed`)),
    );
    lines.push(
      `50 concurrent renames landed: ${
        (await readDirChild(parent)).filter((name) => name.endsWith('-renamed'))
          .length
      }`,
    );
    const contents = await Promise.all(
      made.map(async (name) => {
        const file = await openChild(parent, `${name}-renamed`, DIRECTORY);
        try {
          return (await readDirChild(file)).join(',');
        } finally {
          await file.close();
        }
      }),
    );
    lines.push(
      `each holds its file: ${contents.every((value) => value === 'f')}`,
    );
    const racers = await Promise.all(
      Array.from({ length: 20 }, () =>
        outcome(() => mkdirChild(parent, 'contested')),
      ),
    );
    lines.push(
      `20 racing mkdirs: ${racers.filter((value) => value === 'ok').length} ok, ${
        racers.filter((value) => value === 'EEXIST').length
      } EEXIST`,
    );
    await writeFile(join(base, 'source'), 'S');
    const moves = await Promise.all([
      outcome(() => renameChild(parent, 'source', 'dest-one')),
      outcome(() => renameChild(parent, 'source', 'dest-two')),
    ]);
    lines.push(`two renames of one source: ${moves.sort().join(' ')}`);
    await Promise.all(
      made.map((name) =>
        removeChild(parent, `${name}-renamed`, {
          recursive: true,
          force: true,
        }),
      ),
    );
    lines.push(
      `all temporaries removed concurrently: ${(await readDirChild(parent)).filter((name) => name.startsWith('tmp-')).length}`,
    );
  });
  return lines;
};

const segments: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'segments');
  await withDirectory(base, async (parent) => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
      const label = JSON.stringify(name);
      lines.push(
        `${label}: ${[
          await outcome(() => openChild(parent, name, constants.O_RDONLY)),
          await outcome(() => mkdirChild(parent, name)),
          await outcome(() => renameChild(parent, name, 'x')),
          await outcome(() => renameChild(parent, 'x', name)),
          await outcome(() => removeChild(parent, name)),
          await outcome(() => lstatChild(parent, name)),
        ].join(' ')}`,
      );
    }
  });
  return lines;
};

/** The shape of each failure: code, syscall, a consistent errno and a Node-style message. */
const errors: Scenario = async (dir) => {
  const lines: string[] = [];
  const base = join(dir, 'errors');
  await withDirectory(base, async (parent) => {
    await mkdir(join(base, 'taken'));
    await writeFile(join(base, 'file'), 'x');
    await mkdir(join(base, 'full'));
    await writeFile(join(base, 'full', 'x'), '');
    await mkdir(join(base, 'empty'));
    const cases: [string, () => Promise<void>][] = [
      ['mkdir existing', () => done(mkdirChild(parent, 'taken'))],
      [
        'open missing',
        () => done(openChild(parent, 'missing', constants.O_RDONLY)),
      ],
      ['lstat missing', () => done(lstatChild(parent, 'missing'))],
      ['rename missing', () => done(renameChild(parent, 'missing', 'other'))],
      [
        'rename onto a full directory',
        () => done(renameChild(parent, 'empty', 'full')),
      ],
      ['remove missing', () => done(removeChild(parent, 'missing'))],
      ['remove a directory', () => done(removeChild(parent, 'taken'))],
      [
        'create exclusively over a file',
        () =>
          done(
            openChild(
              parent,
              'file',
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
              0o600,
            ),
          ),
      ],
      [
        'open a file as a directory',
        () => done(openChild(parent, 'file', DIRECTORY)),
      ],
      [
        'mkdir under a file',
        async () => {
          const regular = await openChild(parent, 'file', constants.O_RDONLY);
          try {
            await mkdirChild(regular, 'child');
          } finally {
            await regular.close();
          }
        },
      ],
      [
        'list a file',
        async () => {
          const regular = await openChild(parent, 'file', constants.O_RDONLY);
          try {
            await readDirChild(regular);
          } finally {
            await regular.close();
          }
        },
      ],
    ];
    for (const [label, work] of cases) {
      const failure = await failureOf(work);
      if (failure === undefined) {
        lines.push(`${label}: no error`);
        continue;
      }
      const raw = failure.code ?? 'none';
      // A non-empty target directory is ENOTEMPTY or EEXIST depending on the OS.
      const code =
        label.endsWith('full directory') && raw === 'EEXIST'
          ? 'ENOTEMPTY'
          : raw;
      // SAFETY: a code that names no errno yields undefined, which is handled below.
      const known = (
        code === 'ERR_FS_EISDIR'
          ? osConstants.errno.EISDIR
          : osConstants.errno[code as keyof typeof osConstants.errno]
      ) as number | undefined;
      const errnoMatches =
        known === undefined
          ? 'n/a'
          : String(Math.abs(failure.errno ?? 0) === known);
      const messageMatches =
        code === 'ERR_FS_EISDIR'
          ? failure.message.startsWith('Path is a directory')
          : failure.message.startsWith(`${code}: `) &&
            failure.message.includes(`, ${failure.syscall} `);
      lines.push(
        `${label}: ${code} ${failure.syscall} errno ${errnoMatches} message ${messageMatches}`,
      );
    }
  });
  return lines;
};

export const scenarios = {
  walk,
  files,
  stats,
  renames,
  removals,
  listings,
  swapped,
  concurrency,
  segments,
  errors,
};

export type ScenarioName = keyof typeof scenarios;

export const scenarioNames: readonly ScenarioName[] = [
  'walk',
  'files',
  'stats',
  'renames',
  'removals',
  'listings',
  'swapped',
  'concurrency',
  'segments',
  'errors',
];

/** The transcript of one scenario in a fresh subdirectory of `dir`. */
export async function transcript(
  name: ScenarioName,
  dir: string,
): Promise<string[]> {
  const home = join(dir, name);
  await mkdir(home);
  return await scenarios[name](home);
}
