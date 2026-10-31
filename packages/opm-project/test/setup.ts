/**
 * Process-entry adapter registration for opm-project tests.
 *
 * The library under test never imports concrete adapters; tests use the
 * reference distribution pack the same way the CLI does.
 */
import { afterEach } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { forgetBases } from '@openpacker/project-io';

configureDefaultAdapters();

// Each test is a command of its own: a base one took (a project root, a store
// root) is not a base for the next (ADR 0034, trusted bases).
afterEach(() => {
  forgetBases();
});
