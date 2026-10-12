/**
 * Runs the whole of handle-link.test.ts again with every POSIX child operation
 * routed through the libc `*at()` backend (bound to glibc), so the macOS
 * implementation of `symlinkat` and `readlinkat` has to pass what the
 * /proc/self/fd one passes.
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
    // The suite did its link I/O through the backend under test, not around it.
    expect(calls()).toBeGreaterThan(100);
  });
  await import('./handle-link.test.js');
  it('was routed through the libc backend', () => {
    expect(calls()).toBeGreaterThan(0);
  });
} else {
  it.skip('runs only on Linux with glibc', () => undefined);
}
