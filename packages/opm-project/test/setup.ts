/**
 * Process-entry adapter registration for opm-project tests.
 *
 * The library under test never imports concrete adapters; tests use the
 * reference distribution pack the same way the CLI does.
 *
 * Each test file also runs with its own fresh store and cache directory, and
 * fails if the library would resolve a store or cache outside the temporary
 * directory before or after any test (`store-isolation.ts`).
 */
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { assertResolvedStores, isolateStores } from './store-isolation.js';

configureDefaultAdapters();

const stores = isolateStores();
beforeEach(() => assertResolvedStores());
afterEach(() => assertResolvedStores());
afterAll(() => stores.remove());
