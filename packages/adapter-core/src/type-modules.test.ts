import { describe, expect, it } from 'vitest';
import * as frozenLock from './frozen-lock.js';
import * as frozenPatch from './frozen-patch.js';
import * as layoutWorkspace from './layout-workspace.js';

/**
 * Modules that only declare types.
 *
 * Every consumer imports them as types, so the compiler erases the import and
 * nothing at run time ever loads them. They are loaded here, once, and must stay
 * what they are: a value added to one would be code no import reaches, and the
 * types the entry re-exports from it would no longer be the whole of it.
 */

describe('the frozen-install type modules', () => {
  it.each([
    ['frozen-lock', frozenLock],
    ['frozen-patch', frozenPatch],
    ['layout-workspace', layoutWorkspace],
  ])('%s declares types and exports no value', (_, module) => {
    expect(Object.keys(module)).toEqual([]);
  });
});
