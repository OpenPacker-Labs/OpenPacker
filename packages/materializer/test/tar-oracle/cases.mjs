/**
 * The archives the oracle records, in the order tar-end.test.ts lists the
 * ones the readers install differently. Each group is a module of its own.
 */

import { END_CASES } from './cases-end.mjs';
import { ENTRY_CASES } from './cases-entries.mjs';

export const CASES = { ...END_CASES, ...ENTRY_CASES };
