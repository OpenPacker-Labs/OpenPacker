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

import { constants } from 'node:fs';
import {
  access,
  readFile,
  rename,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { delimiter, dirname, extname, join } from 'node:path';

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
 * the only step that is atomic on both POSIX and Windows. Matches how the opm
 * store and the generation ledger already write.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  // Same directory, so rename cannot cross a filesystem boundary.
  const temporary = join(
    directory,
    `.${basenameOf(path)}.opm-${process.pid}-${writeCounter()}.tmp`,
  );
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

let counter = 0;
function writeCounter(): number {
  counter += 1;
  return counter;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] || 'file';
}

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
    parsed = JSON.parse(file.text) as T;
  } catch (error) {
    throw new ProjectIoError(
      'INVALID_JSON',
      path,
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  materialiseTree,
  removeTree,
  type MaterialiseResult,
} from './layout.js';

export { packTar, packTarGzip, packZip, type ArchiveEntry } from './archive.js';
