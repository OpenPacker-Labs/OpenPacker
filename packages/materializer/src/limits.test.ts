/**
 * The bounds of a path in an archive are one definition, in
 * `@openpacker/adapter-core`, shared with the store's limits and with the paths
 * a pnpm patch may name (ADR 0056 §13). The materializer took 128 and 4,096
 * into a literal of its own, where the two could drift apart silently; these
 * tests fail if it stops reading them from there.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@openpacker/adapter-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openpacker/adapter-core')>()),
  PACKAGE_TREE_LIMITS: {
    maximumFiles: 7,
    maximumPathBytes: 64,
    maximumDepth: 5,
  },
}));

/** The materializer, read after the mock above is in place. */
const materializer = () => import('./index.js');

describe('the bounds of a path in an archive', () => {
  it('are PACKAGE_TREE_LIMITS, whatever it holds: depth and bytes, not files', async () => {
    const { DEFAULT_MATERIALIZATION_LIMITS } = await materializer();
    expect(DEFAULT_MATERIALIZATION_LIMITS).toMatchObject({
      maximumPathBytes: 64,
      maximumDepth: 5,
      // The materializer's own: the store raises it for a dependency tree.
      maximumFiles: 10_000,
    });
  });

  it('refuse a path one past them', async () => {
    const { validateArchivePath } = await materializer();
    expect(validateArchivePath('a/b/c/d/e')).toBe('a/b/c/d/e');
    expect(() => validateArchivePath('a/b/c/d/e/f')).toThrow(
      expect.objectContaining({ code: 'PATH_DEPTH_LIMIT' }),
    );
    expect(validateArchivePath('a'.repeat(64))).toHaveLength(64);
    expect(() => validateArchivePath('a'.repeat(65))).toThrow(
      expect.objectContaining({ code: 'PATH_LENGTH_LIMIT' }),
    );
  });
});
