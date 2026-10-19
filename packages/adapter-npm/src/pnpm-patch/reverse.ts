/**
 * A patch turned around, as `@pnpm/patch-package@0.0.1`'s
 * `dist/patch/reverse.js` turns it: pnpm asks whether the reverse would apply
 * to decide that a patch which failed was already applied (`applyPatch` in
 * `dist/applyPatches.js`).
 */

import { verifyHunkIntegrity, type Hunk, type PatchEffect } from './parse.js';

/** `reverseHunk`: deletions and insertions swap, and so does each adjacent pair. */
function reverseHunk(hunk: Hunk): Hunk {
  const parts = hunk.parts.map((part) =>
    part.type === 'context'
      ? part
      : {
          type:
            part.type === 'deletion'
              ? ('insertion' as const)
              : ('deletion' as const),
          lines: part.lines,
          noNewlineAtEndOfFile: part.noNewlineAtEndOfFile,
        },
  );
  for (let i = 0; i < parts.length - 1; i++)
    if (parts[i]!.type === 'insertion' && parts[i + 1]!.type === 'deletion') {
      const swapped = parts[i]!;
      parts[i] = parts[i + 1]!;
      parts[i + 1] = swapped;
      i += 1;
    }
  const result: Hunk = {
    header: { original: hunk.header.patched, patched: hunk.header.original },
    parts,
  };
  verifyHunkIntegrity(result);
  return result;
}

function reverseEffect(effect: PatchEffect): PatchEffect {
  switch (effect.type) {
    case 'file creation':
    case 'file deletion':
      return {
        type:
          effect.type === 'file creation' ? 'file deletion' : 'file creation',
        path: effect.path,
        hash: effect.hash,
        hunk: effect.hunk && reverseHunk(effect.hunk),
        mode: effect.mode,
      };
    case 'rename':
      return {
        type: 'rename',
        fromPath: effect.toPath,
        toPath: effect.fromPath,
      };
    case 'patch':
      return {
        type: 'patch',
        path: effect.path,
        hunks: effect.hunks.map(reverseHunk),
        beforeHash: effect.afterHash,
        afterHash: effect.beforeHash,
      };
    case 'mode change':
      return {
        type: 'mode change',
        path: effect.path,
        newMode: effect.oldMode,
        oldMode: effect.newMode,
      };
  }
}

/** `reversePatch`: each effect reversed, last first. */
export function reversePatch(effects: readonly PatchEffect[]): PatchEffect[] {
  return effects.map(reverseEffect).reverse();
}
