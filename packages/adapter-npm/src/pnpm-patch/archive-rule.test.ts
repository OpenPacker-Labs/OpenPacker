/**
 * A path a patch may name is a path an archive may hold (ADR 0057 §13): the
 * patch's bounds count what the archive's count. `validateArchivePath` is
 * given `package/<path>` (an npm tarball's root is a directory of the
 * archive), so a path 128 segments below the package is 129 for the archive,
 * and 4,089 bytes are 4,097. A patch path was held to 128 and 4,096 without
 * the root, took 8 bytes and one segment more than any archive would, and the
 * entry it made published, adopted and could not have come from an archive.
 */

import { validateArchivePath } from '@openpacker/materializer';
import { describe, expect, it } from 'vitest';
import { patchPathProblem } from './tree.js';

const archiveHolds = (path: string): boolean => {
  try {
    validateArchivePath(`package/${path}`);
    return true;
  } catch {
    return false;
  }
};

const deep = (segments: number) => Array(segments).fill('d').join('/');
const bytes = (count: number) => {
  // Segments of 50, as many as fit, the last as long as is left.
  const parts: string[] = [];
  let left = count;
  while (left > 0) {
    const take = Math.min(left, 50);
    parts.push('s'.repeat(take));
    left -= take + 1;
  }
  return parts.join('/');
};

describe('the depth and the length of a path', () => {
  it.each([
    [deep(126), true],
    [deep(127), true],
    [deep(128), false],
    [deep(129), false],
    [bytes(4_087), true],
    [bytes(4_088), true],
    [bytes(4_089), false],
    [bytes(4_096), false],
  ])('are held as the archive holds them: %#', (path, accepted) => {
    expect(patchPathProblem(path) === undefined).toBe(accepted);
    expect(archiveHolds(path)).toBe(accepted);
  });

  it('are the same as the archive holds for every depth and length around the bounds', () => {
    const different: string[] = [];
    for (let segments = 120; segments <= 135; segments += 1)
      if (
        (patchPathProblem(deep(segments)) === undefined) !==
        archiveHolds(deep(segments))
      )
        different.push(`${segments} segments`);
    for (let count = 4_070; count <= 4_110; count += 1)
      if (
        (patchPathProblem(bytes(count)) === undefined) !==
        archiveHolds(bytes(count))
      )
        different.push(`${count} bytes`);
    expect(different).toEqual([]);
  });
});

describe('a path of a patch', () => {
  it('is never one the archive refuses, over 30,000 generated paths', () => {
    let state = 11;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state / 0x80000000;
    };
    const names = [
      'a',
      'b',
      'lib',
      'CON',
      'x.',
      'a:b',
      'é',
      'com1',
      'nul.txt',
      'a b',
      '.',
      '..',
      '',
      'Aux',
      'z'.repeat(60),
      'q'.repeat(300),
    ];
    let accepted = 0;
    const wrong: string[] = [];
    for (let count = 0; count < 30_000; count += 1) {
      const depth =
        next() < 0.2
          ? 100 + Math.floor(next() * 40)
          : 1 + Math.floor(next() * 6);
      const noise = depth > 50 ? 0.005 : 0.3;
      const path = Array.from({ length: depth }, () =>
        next() > noise ? 'd' : names[Math.floor(next() * names.length)],
      ).join('/');
      if (patchPathProblem(path) !== undefined) continue;
      accepted += 1;
      if (!archiveHolds(path)) wrong.push(path.slice(0, 80));
    }
    expect(accepted).toBeGreaterThan(5_000);
    expect(wrong).toEqual([]);
  });
});
