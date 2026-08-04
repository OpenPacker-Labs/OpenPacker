/**
 * Process-entry adapter registration for monorepo vitest runs (coverage, gates).
 *
 * Package-local vitest configs also load their own setup; this covers root-level
 * collection where package vitest.config.ts is not applied.
 */
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { tryGetAdapterRegistry } from '@openpacker/adapter-host';

if (!tryGetAdapterRegistry()) configureDefaultAdapters();
