import { enableDefaultSharedStore } from '@openpacker/opm-project';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The file the `opmx` link runs. Like `main.ts` for opm, it holds no logic of
 * its own (`opm.test.ts` covers `runOpmx`), so what is checked here is that
 * loading it runs the command line the process was started with and exits with
 * the code the command returned. No test loaded it before, so the coverage gate
 * counted apps/openpacker-cli one file short.
 */

// What opmx-main.ts runs is the whole opmx CLI: seconds to transform and load
// under Vitest. Loaded here, while the file is collected, so the test's own
// import of opmx-main.ts only runs the entry and its budget holds no one-time
// load. (opmx.ts runs nothing when it is imported rather than started.)
await import('../src/opmx.js');

describe('the process entry of opmx', () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    // The entry switches the default shared store on, as the bin does; this
    // file's other tests (none yet) must not inherit it.
    enableDefaultSharedStore(false);
    vi.restoreAllMocks();
  });

  it('runs the command line it was started with and exits with its code', async () => {
    process.argv = [process.execPath, 'opmx', '--help'];
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await import('../src/opmx-main.js');
    expect(process.exitCode).toBe(0);
    expect(written.join('')).toMatch(/^opmx — execute a package binary/u);
  });
});
