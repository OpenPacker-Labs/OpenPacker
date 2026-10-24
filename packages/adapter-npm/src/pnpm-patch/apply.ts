/**
 * Applying a patch's effects as pnpm applies them (ADR 0057).
 *
 * A port of `@pnpm/patch-package@0.0.1`'s `dist/patch/apply.js`
 * (`executeEffects`, `applyPatch`, `evaluateHunk`) and of `applyPatch` in
 * `dist/applyPatches.js`, as bundled in pnpm 10.28, over a `PatchTree` instead
 * of the process's working directory:
 *
 * - every hunk is placed against the file as it was, at its header's line,
 *   then 1 line up, 1 down, 2 up, ... as far as 20 either way, and a hunk
 *   that does not fit at any of them fails the file;
 * - a line matches when the two are equal after trailing whitespace is
 *   trimmed from both, so a `\r` the file or the patch carries, or a space at
 *   the end of a line, does not stop a hunk; inserted lines are written as
 *   the patch has them, and the file is split and joined at `\n` only;
 * - a new file whose path exists replaces it, a deleted file's contents are
 *   not compared, a mode change sets 644 or 755;
 * - when the patch fails, pnpm asks whether its reverse would apply (a dry
 *   run, in which a mode change still changes the mode) and calls the patch
 *   applied if so: the package already had the change.
 *
 * A `PatchRefusal` is opm's, not pnpm's, and is never taken for a failed
 * patch: the tree is not one opm will patch (a link, a directory renamed), or
 * applying it would cost more than `PATCH_WORK_BUDGET`.
 *
 * pnpm trims with `s.replace(/\s+$/, "")`, which backtracks: a line of n
 * spaces and one letter costs n^2 (80,000 spaces, 12 s). `trimEnd` removes the
 * same characters (`\s` and `trimEnd` both mean WhiteSpace and
 * LineTerminator) in one pass.
 */

import type { Hunk, PatchEffect } from './parse.js';
import { reversePatch } from './reverse.js';

/** What a patch reads and writes, by path below the package. */
export interface PatchTree {
  /** `fs.existsSync`: a file or a directory. */
  exists(path: string): boolean;
  /** `fs.readFileSync(path).toString()`. */
  readText(path: string): string;
  /** `fs.statSync(path).mode`. */
  mode(path: string): number;
  /** `ensureDirSync(dirname(path))`, then `writeFileSync(path, text, { mode })`. */
  write(path: string, text: string, mode: number): void;
  /** `fs.unlinkSync`. */
  unlink(path: string): void;
  /** fs-extra's `moveSync(from, to)`, which never overwrites. */
  move(from: string, to: string): void;
  /** `fs.chmodSync`. */
  chmod(path: string, mode: number): void;
}

/** The tree is not one opm patches; never read as "the patch did not apply". */
export class PatchRefusal extends Error {
  constructor(
    /**
     * `UNSAFE_PATH` for a link or a special file, `SIZE_LIMIT` for a tree
     * past the files an archive may hold, `CASE_COLLISION` for two files an
     * archive would refuse as one, `PATCH_FAILED` otherwise.
     */
    readonly code:
      | 'UNSAFE_PATH'
      | 'SIZE_LIMIT'
      | 'CASE_COLLISION'
      | 'PATCH_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PatchRefusal';
  }
}

type Modification =
  | {
      readonly type: 'splice';
      readonly index: number;
      readonly numToDelete: number;
      readonly linesToInsert: readonly string[];
    }
  | { readonly type: 'pop' }
  | { readonly type: 'push'; readonly line: string };

/**
 * The work one patch may do, in characters of the package's files read,
 * compared and written, lines moved, and paths looked up (`tree.ts`: the
 * ancestors a lookup walks and the `lstat` of each path named). pnpm decodes, splits, joins and
 * writes a whole file for each section that patches it, so K sections that
 * each change one line of one large file cost K times that file: a 146 KB
 * patch of 2,000 such sections ran for a minute, and a 16 MiB one would run
 * for an hour. A real patch changes a file in one section; the largest of the
 * measured ones (ADR 0057 §9) spends a fraction of a percent of this.
 */
export const PATCH_WORK_BUDGET = 256 * 1024 * 1024;

/** What one application of a patch has spent of its budget. */
export class PatchBudget {
  #spent = 0;

  constructor(readonly limit: number = PATCH_WORK_BUDGET) {}

  get spent(): number {
    return this.#spent;
  }

  /** Spend `work`; refuse the patch once the budget is gone. */
  charge(work: number): void {
    this.#spent += work;
    if (this.#spent > this.limit)
      throw new PatchRefusal(
        'PATCH_FAILED',
        `it is too costly to apply: it would read, compare and write more than ${this.limit} characters of the package's files and of the paths it names, which no real patch comes near (a file patched again in section after section, a path a hundred directories deep made again and again), and opm stops there instead of running on as pnpm would`,
      );
  }
}

/** `evaluateHunk`: the changes, if the hunk fits `fuzzingOffset` lines from its place. */
function evaluateHunk(
  hunk: Hunk,
  fileLines: readonly string[],
  fuzzingOffset: number,
  budget: PatchBudget,
): Modification[] | null {
  budget.charge(1);
  const result: Modification[] = [];
  let contextIndex = hunk.header.original.start - 1 + fuzzingOffset;
  if (contextIndex < 0) return null;
  if (fileLines.length - contextIndex < hunk.header.original.length)
    return null;
  for (const part of hunk.parts) {
    if (part.type === 'insertion') {
      result.push({
        type: 'splice',
        index: contextIndex,
        numToDelete: 0,
        linesToInsert: part.lines,
      });
      if (part.noNewlineAtEndOfFile) result.push({ type: 'pop' });
      continue;
    }
    for (const line of part.lines) {
      const original = fileLines[contextIndex]!;
      budget.charge(original.length + line.length + 1);
      if (original.trimEnd() !== line.trimEnd()) return null;
      contextIndex++;
    }
    if (part.type === 'deletion') {
      result.push({
        type: 'splice',
        index: contextIndex - part.lines.length,
        numToDelete: part.lines.length,
        linesToInsert: [],
      });
      if (part.noNewlineAtEndOfFile) result.push({ type: 'push', line: '' });
    }
  }
  return result;
}

/** `applyPatch` of `apply.js`: every hunk placed first, then all written at once. */
function applyHunks(
  tree: PatchTree,
  path: string,
  hunks: readonly Hunk[],
  dryRun: boolean,
  budget: PatchBudget,
): void {
  const text = tree.readText(path);
  budget.charge(text.length + 1);
  const fileLines = text.split(/\n/u);
  const mode = tree.mode(path);
  const result: Modification[][] = [];
  for (const [index, hunk] of hunks.entries()) {
    let fuzzingOffset = 0;
    for (;;) {
      const modifications = evaluateHunk(
        hunk,
        fileLines,
        fuzzingOffset,
        budget,
      );
      if (modifications !== null) {
        result.push(modifications);
        break;
      }
      fuzzingOffset =
        fuzzingOffset < 0 ? fuzzingOffset * -1 : fuzzingOffset * -1 - 1;
      if (Math.abs(fuzzingOffset) > 20)
        throw new Error(`Cant apply hunk ${index} for file ${path}`);
    }
  }
  if (dryRun) return;
  let diffOffset = 0;
  for (const modifications of result)
    for (const modification of modifications)
      switch (modification.type) {
        case 'splice':
          // Every line after the splice moves.
          budget.charge(
            Math.max(fileLines.length - modification.index - diffOffset, 0) + 1,
          );
          fileLines.splice(
            modification.index + diffOffset,
            modification.numToDelete,
            ...modification.linesToInsert,
          );
          diffOffset +=
            modification.linesToInsert.length - modification.numToDelete;
          break;
        case 'pop':
          fileLines.pop();
          break;
        case 'push':
          fileLines.push(modification.line);
      }
  const written = fileLines.join('\n');
  budget.charge(written.length + 1);
  tree.write(path, written, mode);
}

/** A new file's text: the hunk's first part, with a final newline unless it says not. */
function createdText(hunk: Hunk | null): string {
  if (hunk === null) return '';
  const first = hunk.parts[0];
  // pnpm reads `hunk.parts[0].lines` and throws on a hunk with no lines.
  if (first === undefined)
    throw new TypeError(
      "Cannot read properties of undefined (reading 'lines')",
    );
  return first.lines.join('\n') + (first.noNewlineAtEndOfFile ? '' : '\n');
}

/** `executeEffects`. */
export function executeEffects(
  effects: readonly PatchEffect[],
  tree: PatchTree,
  dryRun: boolean,
  budget: PatchBudget = new PatchBudget(),
): void {
  for (const effect of effects) {
    budget.charge(1);
    switch (effect.type) {
      case 'file deletion':
        if (!dryRun) tree.unlink(effect.path);
        else if (!tree.exists(effect.path))
          throw new Error(
            `Trying to delete file that doesn't exist: ${effect.path}`,
          );
        break;
      case 'rename':
        if (!dryRun) tree.move(effect.fromPath, effect.toPath);
        else if (!tree.exists(effect.fromPath))
          throw new Error(
            `Trying to move file that doesn't exist: ${effect.fromPath}`,
          );
        break;
      case 'file creation':
        if (!dryRun) {
          const created = createdText(effect.hunk);
          budget.charge(created.length + 1);
          tree.write(effect.path, created, effect.mode);
        } else if (tree.exists(effect.path))
          throw new Error(
            `Trying to create file that already exists: ${effect.path}`,
          );
        break;
      case 'patch':
        applyHunks(tree, effect.path, effect.hunks, dryRun, budget);
        break;
      case 'mode change':
        // pnpm reads the mode (which throws for a missing file) and sets the
        // new one in a dry run as well.
        tree.mode(effect.path);
        tree.chmod(effect.path, effect.newMode);
    }
  }
}

/**
 * `applyPatch` of `applyPatches.js`: true when the patch applied, or failed
 * and its reverse would apply (it was applied already); false otherwise. What
 * a failed forward run changed stays changed, as it does for pnpm; the caller
 * discards the tree on false.
 */
export function applyEffects(
  effects: readonly PatchEffect[],
  tree: PatchTree,
  budget: PatchBudget = new PatchBudget(),
): boolean {
  try {
    executeEffects(effects, tree, false, budget);
    return true;
  } catch (error) {
    if (error instanceof PatchRefusal) throw error;
    try {
      executeEffects(reversePatch(effects), tree, true, budget);
    } catch (again) {
      if (again instanceof PatchRefusal) throw again;
      return false;
    }
    return true;
  }
}
