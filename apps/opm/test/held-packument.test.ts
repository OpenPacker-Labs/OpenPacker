import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A publish time the abbreviated packument cannot settle is read from the full
 * one, and the full one is the largest document a resolve parses. The tree of
 * the abbreviated one must not be alive while it is: with the budget's copy let
 * go, that tree was held only by the publish-time call that had read it and
 * was waiting for the full one, and a hostile pair of documents (each within
 * its own limit) then ended a process under a 1 GiB heap where either one alone
 * did not. The child measures the heap, after a collection, while the full
 * document is on its way. It needs the packages built: `npm run build`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'support',
  'held-packument-child.mjs',
);

describe('reading the full packument', { timeout: 60_000 }, () => {
  it('does not hold the abbreviated one it read first', () => {
    const result = spawnSync(process.execPath, ['--expose-gc', child, root], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const { heldMiB, evidence } = JSON.parse(result.stdout) as {
      heldMiB: number;
      evidence: unknown;
    };
    expect(evidence).toEqual({
      publishedAt: '2020-01-01T00:00:00.000Z',
      source: 'full-packument',
    });
    // The tree is about 110 MiB; what is left is the process's own churn.
    expect(heldMiB).toBeLessThan(16);
  });
});
