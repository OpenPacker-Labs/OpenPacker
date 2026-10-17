/**
 * The archives the oracle records, in the order tar-end.test.ts lists the
 * ones the readers install differently. Each group is a module of its own.
 */

import { END_CASES } from './cases-end.mjs';
import { ENTRY_CASES } from './cases-entries.mjs';
import { META_CASES } from './cases-meta.mjs';
import { PATH_CASES } from './cases-paths.mjs';
import { NUMBER_CASES } from './cases-numbers.mjs';

export const CASES = {
  ...END_CASES,
  ...ENTRY_CASES,
  ...NUMBER_CASES,
  ...META_CASES,
  ...PATH_CASES,
};
