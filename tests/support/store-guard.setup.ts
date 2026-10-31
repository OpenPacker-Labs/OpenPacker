import { afterEach, beforeEach } from 'vitest';
import { assertResolvedStores } from './store-guard.js';

/**
 * For the suites that can reach a store (opm-project, opm, and the root
 * coverage and gate runs that collect them): a test fails when the library
 * would resolve a store, cache or plugin directory outside the temporary
 * directory, before it runs or after.
 */
beforeEach(() => assertResolvedStores());
afterEach(() => assertResolvedStores());
