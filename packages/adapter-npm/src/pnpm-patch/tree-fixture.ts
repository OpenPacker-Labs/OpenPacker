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
<<<<<<< ours

/**
 * A path of exactly `bytes` UTF-8 bytes whose segments are `unit` repeated
 * (up to 50 times) and no longer than a file name may be: the longest path
 * a patch may name has no segment of 4,096 bytes.
 */
export function pathOfBytes(bytes: number, unit = 'a'): string {
  const width = Buffer.byteLength(unit, 'utf8');
  let path = '';
  let segment = 0;
  while (Buffer.byteLength(path, 'utf8') + width <= bytes) {
    if (segment === 50) {
      // A separator, unless it would leave nothing for the segment after it.
      if (Buffer.byteLength(path, 'utf8') + 1 + width > bytes) break;
      path += '/';
      segment = 0;
    }
    path += unit;
    segment += 1;
  }
  return path;
}
=======
>>>>>>> theirs
