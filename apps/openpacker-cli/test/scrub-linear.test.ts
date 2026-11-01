import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIB, HOSTILE } from './scrub-hostile.js';

/**
 * `scrub` reads text a registry chose, so what it costs is the length of the
 * text. Each text is a mebibyte built to make a scrubber read the same
 * characters again (a run of `a-a-a-…` has a word boundary at every other
 * character, and the first version started a scan of the whole run at each).
 * It was 12 seconds for 80,000 characters of `a-`, and the bound here is 2
 * seconds for 1,048,576, where it now takes tens of milliseconds.
 *
 * Each text runs in a child process (`scrub-timer.ts`), killed at the bound
 * and a margin: a quadratic scrubber would otherwise hold the whole test run
 * for minutes, because a regular expression cannot be interrupted from inside
 * the process that runs it.
 */

const BOUND_MS = 2000;
const KILL_AFTER_MS = BOUND_MS + 3000;
const TIMER = fileURLToPath(new URL('./scrub-timer.ts', import.meta.url));

interface Run {
  milliseconds: number;
  length: number;
  correct: boolean;
}

function run(name: string): Run | 'killed' {
  const result = spawnSync(process.execPath, [TIMER, name], {
    encoding: 'utf8',
    timeout: KILL_AFTER_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (result.error !== undefined || result.signal !== null) return 'killed';
  if (result.status !== 0)
    throw new Error(`the timer failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Run;
}

describe('scrub on a mebibyte built to make it rescan', () => {
  it.each(HOSTILE.map((text) => [text.name, text.size ?? MIB] as const))(
    'is linear: %s',
    (name, size) => {
      const outcome = run(name);
      if (outcome === 'killed')
        throw new Error(
          `scrub had not finished ${size} characters of ${name} after ${KILL_AFTER_MS} ms; the child was killed`,
        );
      expect(outcome.length).toBe(size);
      expect(outcome.correct).toBe(true);
      expect(outcome.milliseconds).toBeLessThan(BOUND_MS);
    },
    60_000,
  );
});
