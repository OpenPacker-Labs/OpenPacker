/**
 * A `patchedDependencies` patch, read and applied as pnpm 10.28 does (ADR
 * 0056): `parse.ts` reads it, `apply.ts` applies it, `tree.ts` holds what it
 * touches until it has applied whole, `hash.ts` is the hash a lock records.
 */

import {
  PACKAGE_TREE_LIMITS,
  ProviderError,
  quote,
  type FrozenPatch,
} from '@openpacker/adapter-core';
import { applyEffects, PatchBudget, PatchRefusal } from './apply.js';
import { HeaderLineTooLong, MAXIMUM_HEADER_LINE } from './header-lines.js';
import { parsePatchFile, type PatchEffect } from './parse.js';
import {
  commitPatchTree,
  entriesOf,
  loadPatchTree,
  patchPathProblem,
  pathsOf,
} from './tree.js';

export {
  hashedPatchText,
  patchHashForm,
  patchHashLike,
  pnpm10PatchHash,
  pnpm9PatchHash,
} from './hash.js';
export { patchPathProblem } from './tree.js';

/**
 * The effects of a patch file, or the coded reason opm will not apply it:
 * `INVALID_PATCH` when pnpm cannot read it either (pnpm's `INVALID_PATCH`),
 * `UNSAFE_PATH` when a path in it leaves the package, which pnpm would follow,
 * or is past the bounds of a path in an archive, and `SIZE_LIMIT` when it
 * names more paths than a package's archive may hold files.
 */
export function readPatchText(text: string, file: string): PatchEffect[] {
  let effects: PatchEffect[];
  try {
    effects = parsePatchFile(text);
  } catch (error) {
    if (error instanceof HeaderLineTooLong)
      throw new ProviderError(
        'SIZE_LIMIT',
        `the patch ${quote(file)} has a header line of ${error.length} characters, more than the ${MAXIMUM_HEADER_LINE} that two paths within the bounds of a path in an archive and the diff line around them come to, so a path in it is past those bounds or the line is no line of a git diff; opm reads no longer one, where pnpm reads whatever is there`,
      );
    throw new ProviderError(
      'INVALID_PATCH',
      `the patch ${quote(file)} cannot be read, as pnpm cannot read it (ERR_PNPM_INVALID_PATCH): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const paths = new Set(pathsOf(effects));
  for (const path of paths) {
    const problem = patchPathProblem(path);
    if (problem !== undefined)
      throw new ProviderError(
        'UNSAFE_PATH',
        `the patch ${quote(file)} names the path ${quote(shown(path))}, which ${problem}; opm applies a patch only below the package it patches`,
      );
  }
  const { maximumFiles } = PACKAGE_TREE_LIMITS;
  if (paths.size > maximumFiles)
    throw new ProviderError(
      'SIZE_LIMIT',
      `the patch ${quote(file)} names ${paths.size} paths, more than the ${maximumFiles} files a package's archive may hold`,
    );
  try {
    entriesOf(paths);
  } catch (error) {
    if (!(error instanceof PatchRefusal)) throw error;
    throw new ProviderError(
      error.code,
      `the patch ${quote(file)} names ${paths.size} paths, which with the directories above them come to more than the ${maximumFiles} files a package's archive may hold`,
    );
  }
  return effects;
}

/** A path as a message shows it: whole when short, its two ends otherwise. */
const shown = (path: string): string =>
  path.length > 160 ? `${path.slice(0, 120)}...${path.slice(-30)}` : path;

/**
 * Apply `patch` to the package whose files are in `packageDir`, whole or not
 * at all. Throws `PATCH_FAILED` when pnpm would refuse it
 * (`ERR_PNPM_PATCH_FAILED`), and the codes of `readPatchText`.
 */
export async function applyPnpmPatch(
  packageDir: string,
  patch: FrozenPatch,
  label: string,
  /** One for the tree read, the patch run and, if it fails, its reverse. */
  budget: PatchBudget = new PatchBudget(),
): Promise<void> {
  const effects = readPatchText(patch.text, patch.file);
  try {
    const tree = await loadPatchTree(packageDir, effects, budget);
    const before = new Map(tree.nodes);
    if (!applyEffects(effects, tree, budget))
      throw new ProviderError(
        'PATCH_FAILED',
        `the patch ${quote(patch.file)} (patchedDependencies ${quote(patch.key)}) does not apply to ${quote(label)}, and pnpm would refuse it too (ERR_PNPM_PATCH_FAILED); nothing was installed`,
      );
    await commitPatchTree(packageDir, before, tree);
  } catch (error) {
    if (error instanceof PatchRefusal)
      throw new ProviderError(
        error.code,
        `the patch ${quote(patch.file)} cannot be applied to ${quote(label)}: ${error.message}`,
      );
    throw error;
  }
}
