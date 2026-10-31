/**
 * Where the work budget is charged in the applier (ADR 0057 §9), one number
 * for a small patch, worked out by hand, so that a charge dropped from any
 * site changes it; and that the forward run and the reverse run that asks
 * whether the package already has the change spend one budget between them.
 * (The tree's own charges are in `tree-work.test.ts`.)
 */

import { describe, expect, it } from 'vitest';
import {
  applyEffects,
  executeEffects,
  PatchBudget,
  PatchRefusal,
  type PatchTree,
} from './apply.js';
import { parsePatchFile } from './parse.js';
import { reversePatch } from './reverse.js';

/** A tree of files in a map, charging nothing: only the applier is measured. */
function files(initial: Record<string, string>): PatchTree {
  const held = new Map(Object.entries(initial));
  const need = (path: string) => {
    const text = held.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  };
  return {
    exists: (path) => held.has(path),
    readText: need,
    mode: (path) => (need(path), 0o644),
    write: (path, text) => void held.set(path, text),
    unlink: (path) => void held.delete(path),
    move: (from, to) => (held.set(to, need(from)), void held.delete(from)),
    chmod: () => undefined,
  };
}

const patch = (...lines: string[]) =>
  parsePatchFile(
    ['diff --git a/f.js b/f.js', '--- a/f.js', '+++ b/f.js', ...lines, ''].join(
      '\n',
    ),
  );

describe('what the applier charges, by site', () => {
  it('is 32 for a file of 3 lines changed in one hunk of 3 lines', () => {
    const effects = patch('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c');
    const budget = new PatchBudget();
    const tree = files({ 'f.js': 'a\nb\nc\n' });
    executeEffects(effects, tree, false, budget);
    expect(tree.readText('f.js')).toBe('a\nB\nc\n');
    // One for the effect.
    // The file read: its 6 characters and one.                         (7)
    // One for the hunk, tried at its own line.                         (1)
    // Three lines compared, each both lengths and one.            (3 x 3 = 9)
    // Two splices, each the lines after it that move, and one: 4 and 3. (7)
    // The file written: its 6 characters and one.                      (7)
    expect(budget.spent).toBe(1 + 7 + 1 + 9 + 7 + 7);
  });

  it('charges a splice the lines after it that move, and a new file its text', () => {
    // 1,000 lines, the first deleted: the splice moves the 1,000 after it.
    const lines = Array.from({ length: 1_000 }, () => 'x');
    const first = new PatchBudget();
    executeEffects(
      patch('@@ -1 +0,0 @@', '-x'),
      files({ 'f.js': `${lines.join('\n')}\n` }),
      false,
      first,
    );
    const last = new PatchBudget();
    executeEffects(
      patch('@@ -1000 +999,0 @@', '-x'),
      files({ 'f.js': `${lines.join('\n')}\n` }),
      false,
      last,
    );
    // The same file read, compared and written; only the splice differs.
    expect(first.spent - last.spent).toBe(1_000 - 1);
    const created = new PatchBudget();
    executeEffects(
      parsePatchFile(
        `diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+${'y'.repeat(500)}\n`,
      ),
      files({}),
      false,
      created,
    );
    // The effect (1) and the new file's 501 characters and one.
    expect(created.spent).toBe(1 + 502);
  });
});

describe('the forward run and its reverse', () => {
  // A hunk that fits nowhere within 20 lines of its place, forward or reversed.
  const effects = patch('@@ -1,2 +1,2 @@', ' a', '-b', '+c');
  const body = `${'z\n'.repeat(60)}`;

  function spend(run: (budget: PatchBudget, tree: PatchTree) => void) {
    const budget = new PatchBudget();
    try {
      run(budget, files({ 'f.js': body }));
    } catch {
      // The failure is the point: what it spent is.
    }
    return budget.spent;
  }

  it('spend one budget between them: the reverse is not given a fresh one', () => {
    const forward = spend((budget, tree) =>
      executeEffects(effects, tree, false, budget),
    );
    const reverse = spend((budget, tree) =>
      executeEffects(reversePatch(effects), tree, true, budget),
    );
    expect(forward).toBeGreaterThan(40);
    expect(reverse).toBeGreaterThan(40);
    // Neither alone would overrun this; both together do.
    const limit = forward + reverse - 1;
    expect(() =>
      applyEffects(effects, files({ 'f.js': body }), new PatchBudget(limit)),
    ).toThrow(PatchRefusal);
    expect(
      applyEffects(
        effects,
        files({ 'f.js': body }),
        new PatchBudget(forward + reverse),
      ),
    ).toBe(false);
  });
});
