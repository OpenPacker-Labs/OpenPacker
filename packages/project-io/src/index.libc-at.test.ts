/**
 * Runs the whole of index.test.ts again with every POSIX child operation
 * routed through the libc `*at()` backend (bound to glibc), so the macOS
 * implementation has to pass the tests the /proc/self/fd one passes.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { useChildBackendForTesting } from './handle-path.js';
import { counting, glibcBackend, glibcLinux } from './handle-test-support.js';

if (glibcLinux()) {
  const { backend, calls } = counting(glibcBackend());
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = useChildBackendForTesting(backend);
  });
  afterAll(() => {
    restore?.();
    // The suite did its I/O through the backend under test, not around it.
    expect(calls()).toBeGreaterThan(100);
  });
  await import('./index.test.js');
  it('was routed through the libc backend', () => {
    expect(calls()).toBeGreaterThan(0);
  });
} else {
  // Without glibc there is no second backend to run; keep the file a suite.
  it.skip('runs only on Linux with glibc', () => undefined);
}
