/**
 * A `patchedDependencies` patch, read and applied as pnpm 10.28 does (ADR
 * 0056): `parse.ts` reads it, `apply.ts` applies it, `tree.ts` holds what it
 * touches until it has applied whole, `hash.ts` is the hash a lock records.
 */

import {
  ProviderError,
  quote,
  type FrozenPatch,
} from '@openpacker/adapter-core';
import { applyEffects, PatchRefusal } from './apply.js';
import { parsePatchFile, type PatchEffect } from './parse.js';
import {
  commitPatchTree,
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
 * `UNSAFE_PATH` when a path in it leaves the package, which pnpm would follow.
 */
export function readPatchText(text: string, file: string): PatchEffect[] {
  let effects: PatchEffect[];
  try {
    effects = parsePatchFile(text);
  } catch (error) {
    throw new ProviderError(
      'INVALID_PATCH',
      `the patch ${quote(file)} cannot be read, as pnpm cannot read it (ERR_PNPM_INVALID_PATCH): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const path of pathsOf(effects)) {
    const problem = patchPathProblem(path);
    if (problem !== undefined)
      throw new ProviderError(
        'UNSAFE_PATH',
        `the patch ${quote(file)} names the path ${quote(path)}, which ${problem}; opm applies a patch only below the package it patches`,
      );
  }
  return effects;
}

/**
 * Apply `patch` to the package whose files are in `packageDir`, whole or not
 * at all. Throws `PATCH_FAILED` when pnpm would refuse it
 * (`ERR_PNPM_PATCH_FAILED`), and the codes of `readPatchText`.
 */
export async function applyPnpmPatch(
  packageDir: string,
  patch: FrozenPatch,
  label: string,
): Promise<void> {
  const effects = readPatchText(patch.text, patch.file);
  try {
    const tree = await loadPatchTree(packageDir, effects);
    const before = new Map(tree.nodes);
    if (!applyEffects(effects, tree))
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
