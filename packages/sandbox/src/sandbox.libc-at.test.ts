/**
 * Runs the sandbox suites again with every POSIX child operation routed
 * through the libc `*at()` backend (bound to glibc). That is the backend macOS
 * uses for the directory grants every run opens (ADR 0045), so the whole
 * sandbox has to work on it as it works on /proc/self/fd.
 *
 * The override belongs to project-io and a test there pins that its package
 * entry does not export it. It is reached here by the file the entry
 * re-exports it from, which is the same module instance, and the counter at
 * the end fails the run if that ever stops being true.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { useChildBackendForTesting } from '../../project-io/dist/esm/handle-path.js';
import {
  counting,
  glibcBackend,
  glibcLinux,
} from '../../project-io/dist/esm/handle-test-support.js';

if (glibcLinux()) {
  const { backend, calls } = counting(glibcBackend());
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = useChildBackendForTesting(backend);
  });
  afterAll(() => {
    restore?.();
    // The suites did their grant opens through the backend under test.
    expect(calls()).toBeGreaterThan(50);
  });
  await import('./paths.test.js');
  await import('./index.test.js');
  await import('./escape.test.js');
  it('was routed through the libc backend', () => {
    expect(calls()).toBeGreaterThan(0);
  });
} else {
  // Without glibc there is no second backend to run; keep the file a suite.
  it.skip('runs only on Linux with glibc', () => undefined);
}
