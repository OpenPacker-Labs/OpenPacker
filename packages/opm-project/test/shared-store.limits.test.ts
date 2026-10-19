/**
 * `limits` carries the option that has an npm archive read as npm and pnpm
 * read it (`requireNpmReaderAgreement`, ADR 0057 §8). The two shared-store
 * functions that extract take it as a required argument, so a call that forgets
 * it does not compile. The fixture is type-checked by tsc here: its
 * `@ts-expect-error` lines are errors themselves if `limits` is optional.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe('the shared store extracts under limits the caller chose', () => {
  it('does not compile a call without limits', () => {
    const tsc = spawnSync(
      here('../../../node_modules/.bin/tsc'),
      ['-p', here('./fixtures/limits/tsconfig.json'), '--noEmit'],
      { encoding: 'utf8' },
    );
    expect(`${tsc.stdout}${tsc.stderr}`).toBe('');
    expect(tsc.status).toBe(0);
  }, 120_000);
});
