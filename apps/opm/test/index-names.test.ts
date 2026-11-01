import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A member named by an array index (`"1023"`) is an element to V8, and the first
 * such member of an object below 1,024 gives it a fast store of up to 5,000
 * slots: `{"1023":0,"2575":0}` kept 31,240 bytes for 20 bytes of text, and a
 * packument of 674 KB of them ended a process with a heap of 1 GiB (exit 134).
 * The parser charges that store (`member-table.ts`), so a packument of such
 * objects at its byte bound is refused, under the abbreviated limit and the
 * full one, in a child process started with the heap limit. The child needs the
 * packages built: `npm run build`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'support',
  'index-names-child.mjs',
);

describe(
  'objects of members named by array indices, under a 1 GiB heap',
  { timeout: 120_000 },
  () => {
    it.each(
      ['idx2', 'idx1', 'idx3'].flatMap((piece) =>
        ['abbreviated', 'full'].map((document) => [piece, document] as const),
      ),
    )('are refused, not fatal: %s at the %s limit', (piece, document) => {
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=1024', child, root, piece, document],
        { encoding: 'utf8', timeout: 110_000, maxBuffer: 1 << 24 },
      );
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toMatch(/heap out of memory|FATAL ERROR/u);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stdout).toMatch(
        document === 'full'
          ? /^refused: Provider metadata exceeds 754974720 bytes of parsed size/u
          : /^refused: Provider metadata exceeds 536870912 bytes of parsed size/u,
      );
    });
  },
);
