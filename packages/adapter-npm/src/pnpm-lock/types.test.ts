import { describe, expect, it } from 'vitest';
import * as types from './types.js';

/**
 * The model of a pnpm lock is types only.
 *
 * Every reader imports it as types, so the compiler erases the import and
 * nothing at run time loads it. It is loaded here, once, and must stay what it
 * is: a value added to it would be code no import reaches.
 */

describe('the pnpm lock model', () => {
  it('declares types and exports no value', () => {
    expect(Object.keys(types)).toEqual([]);
  });
});
