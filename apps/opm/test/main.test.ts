import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The file the `opm`, `opkg` and `opkgm` links run. It holds no logic of its
 * own (`entry.test.ts` covers that), so what is checked here is that loading it
 * runs the command line the process was started with, and that the exit code is
 * the one the command returned.
 */

// What main.ts runs is the whole opm CLI: seconds to transform and load under
// Vitest, more on a loaded machine. Loaded here, while the file is collected,
// so the test's own import of main.ts only runs the entry and its budget holds
// no one-time load.
await import('../src/entry.js');
await import('../src/opm.js');

describe('the process entry of opm', () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('runs the command line it was started with and exits with its code', async () => {
    process.argv = [process.execPath, 'opm', '--help'];
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await import('../src/main.js');
    expect(process.exitCode).toBe(0);
    expect(written.join('')).toMatch(/^opm — Open Package Manager/u);
  });
});
