/**
 * Process-entry adapter registration for opm-project tests.
 *
 * The library under test never imports concrete adapters; tests use the
 * reference distribution pack the same way the CLI does.
 */
import { configureDefaultAdapters } from '@openpacker/adapters-default';

configureDefaultAdapters();
