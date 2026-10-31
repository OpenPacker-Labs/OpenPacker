import { readFile, realpath } from 'node:fs/promises';

/**
 * The mount points strictly inside `dir`, relative to it (Linux: `/proc/self/mountinfo`, field
 * 5, where a space, tab, newline or backslash is an octal escape). Empty where
 * the list cannot be read (another system): opm then learns of one when the
 * file system refuses.
 *
 * Emptying a directory that has a mount point inside it removes the siblings
 * and then stops at the mount, so it is looked for before anything is removed.
 */
export async function mountPointsInside(dir: string): Promise<string[]> {
  const text = await readFile('/proc/self/mountinfo', 'utf8').catch(
    () => undefined,
  );
  if (text === undefined) return [];
  const real = await realpath(dir).catch(() => dir);
  const prefix = real.endsWith('/') ? real : `${real}/`;
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (field === undefined) continue;
    const point = field.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (point.startsWith(prefix)) found.push(point.slice(prefix.length));
  }
  return found.sort();
}
