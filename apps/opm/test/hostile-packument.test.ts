import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../src/opm.js';

/**
 * A packument the bounds let through used to be able to end the process: 64
 * MiB of one object of 3.7 million members, each an empty object, was accepted
 * (4,194,304 values at most) and took 2.1 to 2.6 GB to parse, so a client
 * started with `--max-old-space-size=1024` died with
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` and exit 134 instead
 * of refusing it. The parser now charges what each part of a tree allocates and
 * stops at a budget, so the same document is a refusal, and the heaviest
 * document the budget lets through is read inside the same heap.
 *
 * Each case runs in a child process started with the heap limit, through the
 * real provider, memo, parser and the lock step, the registry transport
 * injected, and reports as the command does (`handleError`). The child needs
 * the packages built: `npm run build`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'support',
  'hostile-packument-child.mjs',
);

function run(kind: string) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=1024', child, root, kind],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 24 },
  );
  return { ...result, seconds: (Date.now() - started) / 1000 };
}

describe('a 64 MiB packument under a 1 GiB heap', { timeout: 120_000 }, () => {
  it.each([
    ['one object of 3.7 million members, each an empty object', 'members'],
    ['22 million empty objects', 'empties'],
  ])('is refused, not fatal: %s', (_, kind) => {
    const result = run(kind);
    // Not `FATAL ERROR ... heap out of memory`, which is a signal and exit 134.
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(134);
    expect(result.stderr).not.toMatch(/heap out of memory|FATAL ERROR/u);
    // What the command says of a registry's document it will not parse.
    expect(result.status).toBe(EXIT_CODES.internal);
    expect(result.stderr).toBe(
      'opm: The packument of hostile is not usable: Provider metadata exceeds 536870912 bytes of parsed size\n',
    );
    expect(result.seconds).toBeLessThan(60);
  });

  it('reads the heaviest document the budget lets through', () => {
    // 3.2 million strings of 14 characters, 95 percent of the budget. It is
    // read whole; what stops the command is that the package has no versions.
    const result = run('worst-accepted');
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toMatch(/heap out of memory|FATAL ERROR/u);
    expect(result.stderr).toBe(
      'opm: pkg:npm/hostile@1.0.0 is absent from the packument\n',
    );
    expect(result.status).toBe(EXIT_CODES.notFound);
    expect(result.seconds).toBeLessThan(60);
  });
});
