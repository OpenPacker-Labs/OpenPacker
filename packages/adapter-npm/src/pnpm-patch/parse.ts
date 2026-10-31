/**
 * A patch file read as pnpm reads one (ADR 0057).
 *
 * pnpm 10.28 applies `patchedDependencies` with its fork of patch-package,
 * `@pnpm/patch-package@0.0.1`, bundled in `pnpm.cjs` as
 * `dist/patch/parse.js`. This is that parser, step for step, so a patch opm
 * accepts is one pnpm accepts and reads the same way: the header and hunk
 * states, a blank or `\r` line read as context, the `\ No newline at end of
 * file` pragma, the hunk-length check, and the second pass that reads a patch
 * without `diff --git` lines (`supportLegacyDiffs`) when the first fails it.
 *
 * Why a port and not the package (ADR 0030, outcome 2): the package changes the
 * process's working directory to the package it patches, writes wherever a
 * path in the patch points (`../../x` included), leaves a package half patched
 * when a later file fails, and brings fs-extra, chalk, klaw-sync and semver.
 * opm's contract is narrower: every path stays below the package, and a patch
 * applies whole or not at all. pnpm's own code is kept as the oracle instead:
 * `test/pnpm-patch-oracle/` drives it, from the pnpm 10.28 bundle, over every
 * case the tests compare.
 *
 * Two of pnpm's regexes backtrack (`index abc..def` and `diff --git a/x b/y`),
 * so they are read in one pass instead (`header-lines.ts`), and a line the
 * parser reads as a header line (it begins `diff --git `, `index `, `--- `...)
 * is refused when longer than that module's bound. A line it reads as nothing,
 * a commit message before the first diff, is taken at any length: it costs a
 * few `startsWith`. The other regexes here run over a line only after a
 * literal prefix and take it in one pass.
 */

import {
  diffLinePaths,
  HeaderLineTooLong,
  indexHashes,
  isBounded,
  MAXIMUM_HEADER_LINE,
} from './header-lines.js';

/** A run of one kind of line in a hunk. */
export interface PatchPart {
  readonly type: 'context' | 'insertion' | 'deletion';
  readonly lines: string[];
  noNewlineAtEndOfFile: boolean;
}

export interface HunkHeader {
  readonly original: { readonly start: number; readonly length: number };
  readonly patched: { readonly start: number; readonly length: number };
}

export interface Hunk {
  readonly header: HunkHeader;
  readonly parts: PatchPart[];
}

/** What a patch does, in the order it does it. */
export type PatchEffect =
  | {
      readonly type: 'file deletion' | 'file creation';
      readonly path: string;
      readonly mode: number;
      readonly hash: string | null;
      readonly hunk: Hunk | null;
    }
  | {
      readonly type: 'rename';
      readonly fromPath: string;
      readonly toPath: string;
    }
  | {
      readonly type: 'patch';
      readonly path: string;
      readonly hunks: readonly Hunk[];
      readonly beforeHash: string | null;
      readonly afterHash: string | null;
    }
  | {
      readonly type: 'mode change';
      readonly path: string;
      readonly oldMode: number;
      readonly newMode: number;
    };

export const NON_EXECUTABLE_FILE_MODE = 0o644;
export const EXECUTABLE_FILE_MODE = 0o755;

/** `parseHunkHeaderLine`: a start below 1 is 1, a missing length is 1. */
export function parseHunkHeaderLine(headerLine: string): HunkHeader {
  const match = /^@@ -(\d+)(,(\d+))? \+(\d+)(,(\d+))? @@.*/u.exec(
    headerLine.trim(),
  );
  if (match === null) throw new Error(`Bad header line: '${headerLine}'`);
  return {
    original: {
      start: Math.max(Number(match[1]), 1),
      length: Number(match[3] || 1),
    },
    patched: {
      start: Math.max(Number(match[4]), 1),
      length: Number(match[6] || 1),
    },
  };
}

interface FilePatch {
  diffLineFromPath: string | null;
  diffLineToPath: string | null;
  oldMode: string | null;
  newMode: string | null;
  deletedFileMode: string | null;
  newFileMode: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  fromPath: string | null;
  toPath: string | null;
  hunks: Hunk[] | null;
}

const emptyFilePatch = (): FilePatch => ({
  diffLineFromPath: null,
  diffLineToPath: null,
  oldMode: null,
  newMode: null,
  deletedFileMode: null,
  newFileMode: null,
  renameFrom: null,
  renameTo: null,
  beforeHash: null,
  afterHash: null,
  fromPath: null,
  toPath: null,
  hunks: null,
});

type LineType = PatchPart['type'] | 'header' | 'pragma';

/** `hunkLinetypes`: a blank line and a lone `\r` are context. */
function lineTypeOf(line: string): LineType | null {
  switch (line[0]) {
    case '@':
      return 'header';
    case '-':
      return 'deletion';
    case '+':
      return 'insertion';
    case ' ':
    case undefined:
    case '\r':
      return 'context';
    case '\\':
      return 'pragma';
    default:
      return null;
  }
}

/** One line of the header part of a file's patch, as `parsePatchLines` reads it. */
function readHeaderLine(file: FilePatch, line: string): void {
  if (line.startsWith('old mode '))
    file.oldMode = line.slice('old mode '.length).trim();
  else if (line.startsWith('new mode '))
    file.newMode = line.slice('new mode '.length).trim();
  else if (line.startsWith('deleted file mode '))
    file.deletedFileMode = line.slice('deleted file mode '.length).trim();
  else if (line.startsWith('new file mode '))
    file.newFileMode = line.slice('new file mode '.length).trim();
  else if (line.startsWith('rename from '))
    file.renameFrom = line.slice('rename from '.length).trim();
  else if (line.startsWith('rename to '))
    file.renameTo = line.slice('rename to '.length).trim();
  else if (line.startsWith('index ')) {
    const hashes = indexHashes(line);
    if (hashes === null) return;
    [file.beforeHash, file.afterHash] = hashes;
  } else if (line.startsWith('--- '))
    file.fromPath = line.slice('--- a/'.length).trim();
  else if (line.startsWith('+++ '))
    file.toPath = line.slice('+++ b/'.length).trim();
}

/** `parsePatchLines`. */
function parsePatchLines(
  lines: readonly string[],
  supportLegacyDiffs: boolean,
): FilePatch[] {
  const result: FilePatch[] = [];
  let current = emptyFilePatch();
  let state: 'parsing header' | 'parsing hunks' = 'parsing header';
  let hunk: Hunk | null = null;
  let part: PatchPart | null = null;
  const commitHunk = (): void => {
    if (hunk === null) return;
    if (part !== null) {
      hunk.parts.push(part);
      part = null;
    }
    current.hunks!.push(hunk);
    hunk = null;
  };
  const commitFilePatch = (): void => {
    commitHunk();
    result.push(current);
    current = emptyFilePatch();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (state === 'parsing header') {
      if (line.startsWith('@@')) {
        state = 'parsing hunks';
        current.hunks = [];
        i--;
      } else if (line.length > MAXIMUM_HEADER_LINE && isBounded(line)) {
        throw new HeaderLineTooLong(line.length);
      } else if (line.startsWith('diff --git ')) {
        if (current.diffLineFromPath) commitFilePatch();
        const paths = diffLinePaths(line);
        if (paths === null) throw new Error(`Bad diff line: ${line}`);
        [current.diffLineFromPath, current.diffLineToPath] = paths;
      } else readHeaderLine(current, line);
      continue;
    }
    if (supportLegacyDiffs && line.startsWith('--- a/')) {
      state = 'parsing header';
      commitFilePatch();
      i--;
      continue;
    }
    const type = lineTypeOf(line);
    switch (type) {
      case 'header':
        commitHunk();
        hunk = { header: parseHunkHeaderLine(line), parts: [] };
        break;
      case null:
        state = 'parsing header';
        commitFilePatch();
        i--;
        break;
      case 'pragma':
        if (!line.startsWith('\\ No newline at end of file'))
          throw new Error(`Unrecognized pragma in patch file: ${line}`);
        if (part === null)
          throw new Error(
            'Bad parser state: No newline at EOF pragma encountered without context',
          );
        (part as PatchPart).noNewlineAtEndOfFile = true;
        break;
      default:
        if (hunk === null)
          throw new Error(
            'Bad parser state: Hunk lines encountered before hunk header',
          );
        if (part !== null && (part as PatchPart).type !== type) {
          (hunk as Hunk).parts.push(part);
          part = null;
        }
        part ??= { type, lines: [], noNewlineAtEndOfFile: false };
        (part as PatchPart).lines.push(line.slice(1));
    }
  }
  commitFilePatch();
  for (const { hunks } of result)
    for (const each of hunks ?? []) verifyHunkIntegrity(each);
  return result;
}

/** `verifyHunkIntegrity`: the header's lengths are the lines the hunk has. */
export function verifyHunkIntegrity(hunk: Hunk): void {
  let originalLength = 0;
  let patchedLength = 0;
  for (const { type, lines } of hunk.parts) {
    if (type !== 'insertion') originalLength += lines.length;
    if (type !== 'deletion') patchedLength += lines.length;
  }
  if (
    originalLength !== hunk.header.original.length ||
    patchedLength !== hunk.header.patched.length
  )
    throw new Error('hunk header integrity check failed');
}

/** `parseFileMode`: only 644 and 755 are file modes a patch may give. */
function parseFileMode(mode: string): number {
  const parsed = Number.parseInt(mode, 8) & 0o777;
  if (parsed !== NON_EXECUTABLE_FILE_MODE && parsed !== EXECUTABLE_FILE_MODE)
    throw new Error(`Unexpected file mode string: ${mode}`);
  return parsed;
}

/** `interpretParsedPatchFile`. */
function interpret(files: readonly FilePatch[]): PatchEffect[] {
  const result: PatchEffect[] = [];
  for (const file of files) {
    const { renameFrom, renameTo, deletedFileMode, newFileMode, hunks } = file;
    let destination: string | null = null;
    if (renameFrom) {
      if (!renameFrom || !renameTo)
        throw new Error('Bad parser state: rename from & to not given');
      result.push({ type: 'rename', fromPath: renameFrom, toPath: renameTo });
      destination = renameTo;
    } else if (deletedFileMode || newFileMode) {
      const deletion = Boolean(deletedFileMode);
      const path = deletion
        ? file.diffLineFromPath || file.fromPath
        : file.diffLineToPath || file.toPath;
      if (!path)
        throw new Error(
          `Bad parse state: no path given for file ${deletion ? 'deletion' : 'creation'}`,
        );
      result.push({
        type: deletion ? 'file deletion' : 'file creation',
        hunk: hunks?.[0] ?? null,
        path,
        mode: parseFileMode(deletion ? deletedFileMode! : newFileMode!),
        hash: deletion ? file.beforeHash : file.afterHash,
      });
    } else destination = file.toPath || file.diffLineToPath;
    const { oldMode, newMode } = file;
    if (destination && oldMode && newMode && oldMode !== newMode)
      result.push({
        type: 'mode change',
        path: destination,
        oldMode: parseFileMode(oldMode),
        newMode: parseFileMode(newMode),
      });
    if (destination && hunks && hunks.length > 0)
      result.push({
        type: 'patch',
        path: destination,
        hunks,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
      });
  }
  return result;
}

/**
 * `parsePatchFile`: the text split at `\n` (a `\r` stays on its line), the last
 * empty line dropped, then read; read again as a legacy diff when a hunk's
 * length does not add up. Throws what pnpm throws, in its words.
 */
export function parsePatchFile(text: string): PatchEffect[] {
  const lines = text.split(/\n/gu);
  if (lines.at(-1) === '') lines.pop();
  try {
    return interpret(parsePatchLines(lines, false));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'hunk header integrity check failed'
    )
      return interpret(parsePatchLines(lines, true));
    throw error;
  }
}
