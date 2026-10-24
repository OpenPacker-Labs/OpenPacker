/**
 * Where a descriptor is turned into a path, the path is Linux's. Joining a name
 * onto `/proc/self/fd/N` or `/dev/fd/N` reads a child of an open directory on
 * Linux and names nothing on macOS (ADR 0045), so the only code in this package
 * that may build such a path is the snapshot of a delegated executable, which
 * is Linux-only by refusal (`delegatedExecutionRefusal`). Everything that reads
 * the output directory goes through project-io's handle-relative operations.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = new URL('.', import.meta.url).pathname;

/** Prose may name the paths; only code can build one. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

const productionFiles = readdirSync(source).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

/** The files that may name a descriptor path, and why. */
const linuxOnly: Readonly<Record<string, string>> = {
  'executable.ts':
    'reopens its own unnamed O_TMPFILE writer read-only; refused off Linux before it runs',
};

describe('descriptor paths in pack-provider', () => {
  it('finds the production sources', () => {
    expect(productionFiles).toContain('packer.ts');
    expect(productionFiles).toContain('collect.ts');
  });

  it.each(productionFiles)(
    '%s builds no /proc/self/fd or /dev/fd path',
    (file) => {
      const text = withoutComments(readFileSync(join(source, file), 'utf8'));
      const uses =
        /\/proc\/|\/dev\/fd|\bstableHandlePath\b|handlePathForPlatform/u;
      if (file in linuxOnly) {
        expect(text).toMatch(uses);
        return;
      }
      expect(text).not.toMatch(uses);
    },
  );
});
