/**
 * What `opm ci` exits with when a shared store entry it linked from vanished
 * while it installed: unavailable when the entry could not be put back (it may
 * work when retried), and a verification failure when what was fetched to put
 * it back is not what the lock pins (it will not).
 */

import { describe, expect, it } from 'vitest';
import { OpmError } from '@openpacker/opm-project';
import { EXIT_CODES, handleError } from '../src/opm.js';

function exitFor(error: Error): { status: number; said: string } {
  let said = '';
  const status = handleError(error, {
    stdout: { write: () => true },
    stderr: { write: (text: string) => ((said += text), true) },
  });
  return { status, said };
}

describe('a store entry that vanished during opm ci', () => {
  it('exits unavailable (8) when it could not be put back, and names the entry', () => {
    const vanished = new OpmError(
      'STORE_ENTRY_VANISHED',
      'The shared store entry /store/sha256-abc (a@1.0.0 (node_modules/a)) was removed while this install was linking from the store, and could not be put back: offline',
    );

    const { status, said } = exitFor(vanished);

    expect(EXIT_CODES.unavailable).toBe(8);
    expect(status).toBe(EXIT_CODES.unavailable);
    expect(said).toContain('/store/sha256-abc (a@1.0.0 (node_modules/a))');
  });

  it('exits as a verification failure (7) when what was fetched to put it back does not match the lock', () => {
    const mismatch = new OpmError(
      'DIGEST_MISMATCH',
      'The shared store entry /store/sha256-abc (a@1.0.0 (node_modules/a)) was removed while this install was linking from the store, and could not be put back: a@1.0.0 (node_modules/a) does not match the integrity the lock pins',
    );

    const { status } = exitFor(mismatch);

    expect(EXIT_CODES.verificationFailed).toBe(7);
    expect(status).toBe(EXIT_CODES.verificationFailed);
  });
});
