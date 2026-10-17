/**
 * Keeps opm's tests away from the caller's package store and caches.
 *
 * The process entries turn the user-level shared store on, the plugin commands
 * use the user-level plugin store, and every opm a test starts inherits this
 * process's environment, so each test file gets fresh store, cache and plugin
 * directories and fails if any of them would resolve outside the temporary
 * directory before or after any test.
 * The rules live with the library's own suite (`store-isolation.ts`).
 */
import { pluginStoreRoot } from '@openpacker/plugin-store';
import { afterAll, afterEach, beforeEach } from 'vitest';
import {
  assertResolvedStores,
  isolateStores,
} from '../../../packages/opm-project/test/store-isolation.js';

const stores = isolateStores();
const plugins = { 'The plugin store': () => pluginStoreRoot() };
beforeEach(() => assertResolvedStores(plugins));
afterEach(() => assertResolvedStores(plugins));
afterAll(() => stores.remove());
