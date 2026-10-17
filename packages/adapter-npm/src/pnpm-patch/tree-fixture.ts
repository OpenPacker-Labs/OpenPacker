/** A package's files as the patch suites compare them: text, and whether executable. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export async function readTree(
  root: string,
): Promise<Record<string, { text: string; executable: boolean }>> {
  const out: [string, { text: string; executable: boolean }][] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const where = join(directory, entry.name);
      if (entry.isDirectory()) await walk(where);
      else
        out.push([
          relative(root, where).split('\\').join('/'),
          {
            text: await readFile(where, 'utf8'),
            executable: ((await stat(where)).mode & 0o111) !== 0,
          },
        ]);
    }
  };
  await walk(root);
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
}
