/** Types for src/tar-fuzz.test.ts: the fuzz families by name (families.mjs). */

import type { Archive } from './fuzz.mjs';

export const FAMILIES: Record<
  string,
  (seed?: number, count?: number) => Iterable<Archive>
>;
