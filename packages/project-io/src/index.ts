/**
 * Safe edits to hand-maintained project files.
 *
 * `package.json`, `*.csproj` and `pyproject.toml` are written by people, live
 * in version control, and carry comments and formatting someone chose. A
 * projection that parses and re-serialises them reformats the whole file on
 * every `opm add`, which turns a one-line dependency change into a diff nobody
 * can review. So the rule here is: read, change the smallest span that has to
 * change, write back with everything else byte-identical.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  open,
  readFile,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  mkdirChild,
  openChild,
  removeChild,
  renameChild,
  supportsStableHandles,
} from './handle-path.js';

/** Resolve a command without executing project- or PATH-controlled code. */
export async function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32' && extname(name) === ''
      ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

export class ProjectIoError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = 'ProjectIoError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Conflict markers mean the file is mid-merge. Rewriting it would resolve
 * someone's merge for them, badly and silently.
 */
const CONFLICT = /^(?:<{7}|={7}|>{7})(?: |$)/mu;

export interface TextFile {
  path: string;
  text: string;
  /** Line ending the file already uses. */
  newline: '\n' | '\r\n';
  /** Whether the file ends with a newline. */
  trailingNewline: boolean;
}

export async function readTextFile(path: string): Promise<TextFile> {
  const raw = await readFile(path, 'utf8');
  if (CONFLICT.test(raw))
    throw new ProjectIoError(
      'CONFLICTED_FILE',
      path,
      `${path} contains merge conflict markers; resolve the conflict before opm writes to it`,
    );
  return {
    path,
    text: raw,
    newline: raw.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: raw.endsWith('\n'),
  };
}

/**
 * Write via a temporary file in the same directory, then rename.
 *
 * A half-written `package.json` is worse than an unmodified one, and rename is
 * the atomic publication step on supported POSIX hosts. Windows is refused by
 * the stable-directory boundary below rather than falling back to pathnames.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = resolve(dirname(path));
  const name = basename(path);
  const parent = await openStableDirectory(directory);
  const temporary = `.${name}.opm-${randomUUID()}.tmp`;
  try {
    await assertNamedDirectory(directory, parent);
    const file = await openChild(
      parent,
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(contents);
      // O_CREAT applies the mode through the umask; an executable shim must
      // keep its bits whatever the umask is.
      if (options.mode !== undefined) await file.chmod(options.mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await assertNamedDirectory(directory, parent);
    await renameChild(parent, temporary, name);
    await assertNamedDirectory(directory, parent);
  } catch (error) {
    await removeChild(parent, temporary, { force: true }).catch(
      () => undefined,
    );
    throw error;
  } finally {
    await parent.close();
  }
}

export async function openStableDirectory(path: string): Promise<FileHandle> {
  if (!supportsStableHandles())
    throw new ProjectIoError(
      'UNSAFE_PATH',
      path,
      'Atomic project writes require stable directory handles on this platform',
    );
  const root = parse(path).root;
  let handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      await mkdirChild(handle, part).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const next = await openChild(
        handle,
        part,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertNamedDirectory(
  path: string,
  handle: FileHandle,
): Promise<void> {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (opened.dev !== named.dev || opened.ino !== named.ino)
    throw new ProjectIoError(
      'UNSAFE_PATH',
      path,
      `Atomic write parent changed during publication: ${path}`,
    );
}

export {
  assertHandleSegment,
  handlePathForPlatform,
  linkChild,
  lstatChild,
  mkdirChild,
  mkdtempChild,
  openChild,
  readDirChild,
  readDirChildWithTypes,
  removeChild,
  renameChild,
  stableHandlePath,
  supportsStableHandles,
  windowsNtHandlePathForm,
  StableHandleError,
} from './handle-path.js';

/** Restore a file's original line endings and trailing-newline habit. */
export function matchFileStyle(file: TextFile, body: string): string {
  const normalized = body.replace(/\r\n/gu, '\n');
  const withTrailing = file.trailingNewline
    ? normalized.endsWith('\n')
      ? normalized
      : `${normalized}\n`
    : normalized.replace(/\n$/u, '');
  return file.newline === '\r\n'
    ? withTrailing.replace(/\n/gu, '\r\n')
    : withTrailing;
}

export interface JsonStyle {
  /** The literal indent unit — two spaces, four spaces, a tab. */
  indent: string;
}

/**
 * The indentation a JSON file already uses.
 *
 * `JSON.stringify` needs to be told, and telling it wrong rewrites every line.
 */
export function detectJsonStyle(text: string): JsonStyle {
  const match = /\n([ \t]+)(?=["}\]])/u.exec(text);
  return { indent: match?.[1] ?? '  ' };
}

/**
 * Edit a JSON file in place, preserving its indentation and line endings.
 *
 * Whole-document re-serialisation, unlike the text formats below: JSON has no
 * comments to lose, key order is preserved by the mutation itself, and the
 * alternative — string-splicing into nested objects — is where the real bugs
 * would be.
 */
export async function editJsonFile<T>(
  path: string,
  edit: (value: T) => T | void,
): Promise<{ changed: boolean }> {
  const file = await readTextFile(path);
  const style = detectJsonStyle(file.text);
  let parsed: T;
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    parsed = JSON.parse(file.text) as T;
  } catch (error) {
    throw new ProjectIoError(
      'INVALID_JSON',
      path,
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const result = (edit(parsed) ?? parsed) as T;
  const body = JSON.stringify(result, undefined, style.indent);
  const next = matchFileStyle(file, body);
  if (next === file.text) return { changed: false };
  await writeFileAtomic(path, next);
  return { changed: true };
}

/**
 * Replace one span of a text file, or append when there is nothing to replace.
 *
 * The unit the TOML and XML formats build on: they locate a span with their own
 * parser and hand it here, so only those bytes move.
 */
export interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
}

export function applySpanEdits(
  text: string,
  edits: readonly SpanEdit[],
): string {
  // Right to left, so an earlier edit's offsets stay valid.
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  for (const [index, edit] of ordered.entries()) {
    if (edit.start < 0 || edit.end > text.length || edit.start > edit.end)
      throw new RangeError(
        `Span edit ${index} is out of bounds: ${edit.start}..${edit.end} of ${text.length}`,
      );
    const previous = ordered[index - 1];
    if (previous && edit.end > previous.start)
      throw new RangeError('Span edits overlap');
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return text;
}

export {
  editTomlArray,
  editTomlTable,
  type TomlArrayEdit,
  type TomlTableEdit,
} from './toml.js';

export {
  collectFiles,
  collectFilesFromHandle,
  materialiseTree,
  removeTree,
  supportsStableTreeLayout,
  type MaterialiseOptions,
  type MaterialiseResult,
} from './layout.js';

export { packTar, packTarGzip, packZip, type ArchiveEntry } from './archive.js';
