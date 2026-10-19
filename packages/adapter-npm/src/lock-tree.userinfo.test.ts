import { describe, expect, it } from 'vitest';
import { parsePackageLockText } from './lock-tree.js';

/**
 * A lock's key is repeated in what opm ci refuses. One that holds a user name
 * and a password before a host with no scheme in front of them
 * (`node_modules/https:/user:x@host`) was repeated whole, on the same line where
 * the same text as a package name was `[address withheld]`.
 */

const SECRET = 'vtok_dummy_marker_0123456789abcdef';

describe('a lock key that holds a credential with no scheme', () => {
  it('is refused without the credential', () => {
    const key = `node_modules/https:/user:${SECRET}@r.test`;
    const text = JSON.stringify({
      name: 'a',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': {}, [key]: { version: '1.0.0' } },
    });
    expect(() => parsePackageLockText(text)).toThrow(/address withheld/u);
    try {
      parsePackageLockText(text);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain('user:');
    }
  });
});
