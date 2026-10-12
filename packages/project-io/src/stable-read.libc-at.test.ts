/**
 * Runs the whole of stable-read.test.ts again with every POSIX child operation
 * routed through the libc `*at()` backend (bound to glibc), so the macOS
 * implementation of the bounded listing and of the stable path open has to
 * agree with the /proc/self/fd one.
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
    expect(calls()).toBeGreaterThan(15);
  });
  await import('./stable-read.test.js');
  it('was routed through the libc backend', () => {
    expect(calls()).toBeGreaterThan(0);
  });
} else {
  // Without glibc there is no second backend to run; keep the file a suite.
  it.skip('runs only on Linux with glibc', () => undefined);
}
