/**
 * The bounds of a path in an archive and the names an archive refuses are one
 * definition, in `@openpacker/adapter-core`, shared with the store's limits
 * and with the paths a pnpm patch may name (ADR 0056 §13). The materializer
 * took 128 and 4,096 into a literal of its own, where the two could drift
 * apart silently; these tests fail when the two differ.
 */

import { PACKAGE_TREE_LIMITS, segmentProblem } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  validateArchivePath,
} from './index.js';

describe('the bounds of a path in an archive', () => {
  it('are PACKAGE_TREE_LIMITS: depth and bytes, not files', () => {
    expect(DEFAULT_MATERIALIZATION_LIMITS).toMatchObject({
      maximumPathBytes: PACKAGE_TREE_LIMITS.maximumPathBytes,
      maximumDepth: PACKAGE_TREE_LIMITS.maximumDepth,
    });
    // The materializer's own: the store raises it for a dependency tree.
    expect(DEFAULT_MATERIALIZATION_LIMITS.maximumFiles).toBeLessThan(
      PACKAGE_TREE_LIMITS.maximumFiles,
    );
  });

  it('refuse a path one past them', () => {
    const { maximumDepth, maximumPathBytes } = PACKAGE_TREE_LIMITS;
    const deep = (segments: number) => Array(segments).fill('a').join('/');
    expect(validateArchivePath(deep(maximumDepth))).toBe(deep(maximumDepth));
    expect(() => validateArchivePath(deep(maximumDepth + 1))).toThrow(
      expect.objectContaining({ code: 'PATH_DEPTH_LIMIT' }),
    );
    const long = (bytes: number) =>
      Array(Math.ceil(bytes / 100))
        .fill('a'.repeat(99))
        .join('/')
        .slice(0, bytes - 1)
        .concat('a');
    expect(validateArchivePath(long(maximumPathBytes))).toHaveLength(
      maximumPathBytes,
    );
    expect(() => validateArchivePath(long(maximumPathBytes + 1))).toThrow(
      expect.objectContaining({ code: 'PATH_LENGTH_LIMIT' }),
    );
  });
});

describe('the names an archive refuses', () => {
  it.each([
    ['lib/aux.js', 'WINDOWS_RESERVED_NAME'],
    ['lib/CON', 'WINDOWS_RESERVED_NAME'],
    ['lib/nul.txt', 'WINDOWS_RESERVED_NAME'],
    ['lib/a:b', 'WINDOWS_ALTERNATE_DATA_STREAM'],
    ['lib/trailing.', 'WINDOWS_TRAILING_CHARACTER'],
    ['lib/space ', 'WINDOWS_TRAILING_CHARACTER'],
    ['lib/com1.json', 'WINDOWS_RESERVED_NAME'],
  ])('refuse %s as %s, the code of the shared rule', (path, code) => {
    expect(() => validateArchivePath(`package/${path}`)).toThrow(
      expect.objectContaining({ code }),
    );
    expect(segmentProblem(path.split('/')[1]!)?.code).toBe(code);
  });

  it.each(['lib/X.js', 'lib/console.js', 'lib/auxiliary', 'lib/com10.js'])(
    'take %s',
    (path) => {
      expect(validateArchivePath(`package/${path}`)).toBe(`package/${path}`);
      expect(segmentProblem(path.split('/')[1]!)).toBeUndefined();
    },
  );
});
