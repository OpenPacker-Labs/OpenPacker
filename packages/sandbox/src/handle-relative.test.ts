/**
 * Where a descriptor is turned into a path, the path is Linux's. Joining a name
 * onto `/proc/self/fd/N` or `/dev/fd/N` reads a child of an open directory on
 * Linux and names nothing on macOS (ADR 0045). The grants a run opens go
 * through project-io's handle-relative walk; the two places that still name
 * `/proc/self/fd/N` are the child's own descriptor, which only Linux can
 * execute, and each is refused off Linux before it is reached
 * (`executableAuthorityRefusal`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = new URL('.', import.meta.url).pathname;

/** Prose may name the paths; only code can build one. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

function productionFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? productionFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [`${prefix}${entry.name}`]
        : [],
  );
}

const files = productionFiles(source);

/** The files that may name a descriptor path, and why. */
const linuxOnly: Readonly<Record<string, string>> = {
  'backends/mock.ts':
    "the child's inherited descriptor as its argv[0]; refused off Linux first",
  'backends/native.ts':
    'reopens an executable snapshot for its own offset; refused off Linux first',
  'platform.ts': 'names the paths in the refusal message',
  'listen-watch.ts':
    "reads a bwrap run's processes and sockets under /proc/<pid>, never a descriptor; bwrap is Linux's",
};

describe('descriptor paths in the sandbox', () => {
  it('finds the production sources', () => {
    expect(files).toContain('paths.ts');
    expect(files).toContain('backends/native.ts');
  });

  it.each(files)('%s builds no join onto /proc/self/fd or /dev/fd', (file) => {
    const text = withoutComments(readFileSync(join(source, file), 'utf8'));
    const uses = /\/proc\/|\/dev\/fd|\bstableHandlePath\b/u;
    if (file in linuxOnly) {
      expect(text).toMatch(uses);
      return;
    }
    expect(text).not.toMatch(uses);
  });
});
