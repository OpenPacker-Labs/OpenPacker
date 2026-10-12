/**
 * Runs the whole of member-link.test.ts again with every POSIX child operation
 * routed through the libc `*at()` backend (bound to glibc).
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
    expect(calls()).toBeGreaterThan(100);
  });
  await import('./member-link.test.js');
  it('was routed through the libc backend', () => {
    expect(calls()).toBeGreaterThan(0);
  });
} else {
  it.skip('runs only on Linux with glibc', () => undefined);
}
