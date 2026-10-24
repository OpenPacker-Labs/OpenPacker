/**
 * Helpers for the suites that drive the libc `*at()` backend on Linux.
 */

import { createLibcAtBackend, type ChildBackend } from './handle-libc.js';
import { linuxGlibcProfile } from './handle-libc-profile.js';

interface ProcessReport {
  header: { glibcVersionRuntime?: string };
}

/** The glibc backend runs here only on Linux with glibc (not musl). */
export function glibcLinux(): boolean {
  if (process.platform !== 'linux') return false;
  // SAFETY: Node documents this report header; the field is absent on musl.
  const report = process.report.getReport() as ProcessReport;
  return report.header.glibcVersionRuntime !== undefined;
}

/** A backend that counts what is asked of it, to prove it was the one used. */
export function counting(inner: ChildBackend): {
  backend: ChildBackend;
  calls: () => number;
} {
  let calls = 0;
  const tick = <Args extends unknown[], Result>(
    run: (...args: Args) => Result,
  ): ((...args: Args) => Result) => {
    return (...args) => {
      calls += 1;
      return run(...args);
    };
  };
  return {
    calls: () => calls,
    backend: {
      id: inner.id,
      openChild: tick(inner.openChild),
      mkdirChild: tick(inner.mkdirChild),
      renameChild: tick(inner.renameChild),
      removeChild: tick(inner.removeChild),
      lstatChild: tick(inner.lstatChild),
      readDirChild: tick(inner.readDirChild),
      readDirChildWithTypes: tick(inner.readDirChildWithTypes),
      readDirChildBounded: tick(inner.readDirChildBounded),
      symlinkChild: tick(inner.symlinkChild),
      readlinkChild: tick(inner.readlinkChild),
      unlinkNonDirectory: tick(inner.unlinkNonDirectory),
      rmdirChild: tick(inner.rmdirChild),
    },
  };
}

/** The shipping implementation, bound to glibc instead of libSystem. */
export function glibcBackend(): ChildBackend {
  return createLibcAtBackend(linuxGlibcProfile());
}
