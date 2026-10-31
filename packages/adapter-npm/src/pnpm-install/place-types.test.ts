import { describe, expect, it } from 'vitest';
import * as types from './place-types.js';

/**
 * The placement model of a pnpm install is types only.
 *
 * Every module of the placement imports it as types, so the compiler erases the
 * import and nothing at run time loads it. It is loaded here, once, and must
 * stay what it is: a value added to it would be code no import reaches.
 */

describe('the pnpm placement model', () => {
  it('declares types and exports no value', () => {
    expect(Object.keys(types)).toEqual([]);
  });
});
