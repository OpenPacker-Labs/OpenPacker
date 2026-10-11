import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bytes on disk for a set of paths, each inode counted once however many names
 * it has and whichever path it is reached by — what `du` prints when given all
 * of them in one invocation. Blocks, not file sizes, so directories count.
 */
export async function uniqueBytes(paths: readonly string[]): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path, { bigint: true });
    const id = `${info.dev}:${info.ino}`;
    if (!seen.has(id)) {
      seen.add(id);
      total += Number(info.blocks) * 512;
    }
    if (info.isDirectory())
      for (const name of await readdir(path)) await visit(join(path, name));
  };
  for (const path of paths) await visit(path);
  return total;
}
