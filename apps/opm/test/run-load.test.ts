/**
 * `opm run` and `opm exec` are answered before the project library is loaded
 * (ADR 0047). That is a property of the import graph, so it is read from the
 * sources: from the process entry and from the command, nothing that is
 * imported for a value at load time may leave Node's own modules and this
 * directory. A dynamic `import()` is how a rare path reaches the library.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findOpmRoot } from '@openpacker/opm-project';
import { findProjectRoot } from '../src/commands/run-paths.js';
import { makeDirectory, makeProject } from './run-fixture.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Specifiers imported for a value, as written, with the file that wrote them. */
async function staticImports(
  file: string,
): Promise<{ file: string; specifier: string }[]> {
  const text = await readFile(file, 'utf8');
  const found: { file: string; specifier: string }[] = [];
  for (const match of text.matchAll(
    /^import\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)';/gmu,
  ))
    if (match[1] === undefined && match[2] !== undefined)
      found.push({ file, specifier: match[2] });
  return found;
}

async function loadGraph(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier } of await staticImports(file)) {
      if (specifier.startsWith('.'))
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/u, '.ts')));
      else if (!specifier.startsWith('node:')) external.add(specifier);
    }
  }
  return external;
}

describe('what opm run and opm exec load', () => {
  it.each(['entry.ts', 'commands/run.ts', 'main.ts'])(
    'nothing but Node and this directory is imported for a value by %s',
    async (entry) => {
      expect([...(await loadGraph(join(src, entry)))]).toEqual([]);
    },
  );

  it('keeps the library out of the load graph but not out of the failure path', async () => {
    const text = await readFile(join(src, 'commands/run.ts'), 'utf8');
    expect(text).toMatch(/await import\('@openpacker\/opm-project'\)/u);
  });
});

describe('findProjectRoot', () => {
  it('answers what findOpmRoot answers', async () => {
    const root = await makeProject({ opm: true });
    const deep = await makeDirectory(root, 'a/b/c');
    const bare = await makeProject({});
    for (const start of [root, deep, bare])
      expect(await findProjectRoot(start)).toBe(await findOpmRoot(start));
    expect(await findProjectRoot(deep)).toBe(root);
  });
});
