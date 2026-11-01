/**
 * A bin shim written by `opm` started from a source build: `node
 * apps/openpacker-cli/dist/main.js`, as the guide's from-a-checkout instructions run it.
 * The shim re-enters through the `opmx` beside the entry it was written by,
 * and found `dist/opmx.js`, which tsc does not make executable; it spawned it
 * as a program, and every `.opm/bin/<tool>` failed with `spawn … EACCES`,
 * exit 78. A shim now starts a JavaScript `opmx` with Node.
 *
 * This runs the build output: `npm run build -w @openpacker/cli` first.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT_TOOL_PURL,
  appRoot,
  makeExitToolProject,
  run,
  type Finished,
} from './bins-fixture.js';

const main = join(appRoot, 'dist', 'main.js');

beforeAll(async () => {
  await access(main).catch(() => {
    throw new Error(
      'dist/main.js is not built; run: npm run build -w @openpacker/cli',
    );
  });
});

/** Start a file as a program, the way a shell runs `.opm/bin/<tool>`. */
function execute(file: string, args: readonly string[], cwd: string) {
  return new Promise<Finished>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, OPM_STORE_HOME: 'off', NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) =>
      resolve({ status, signal, stdout, stderr }),
    );
  });
}

// Three starts of the built opm, init, add and the shim's opmx, each loading
// all of it: 2 to 8 s here, so not the 5 s default. The figure bins.test.ts
// uses for the same steps.
describe(
  'a shim written by opm from a source build',
  { timeout: 60_000 },
  () => {
    it('runs its tool through opmx', async () => {
      const project = await makeExitToolProject();
      const init = await run(main, ['init', '--name', 'shim-project'], project);
      expect(init.status, init.stderr).toBe(0);
      const added = await run(
        main,
        ['add', EXIT_TOOL_PURL, '--offline'],
        project,
      );
      expect(added.status, added.stderr).toBe(0);

      const ran = await execute(
        join(project, '.opm', 'bin', 'exit-tool'),
        ['3'],
        project,
      );
      expect(ran.stderr).not.toContain('EACCES');
      if (ran.stderr.includes('sandbox was not enforced')) {
        // No containment backend on this host: opmx itself was reached, and
        // refused, which is what a shim that started it is to show.
        expect(ran.status).toBe(6);
      } else {
        expect([ran.status, ran.stdout, ran.stderr]).toEqual([
          3,
          'exit-tool ran\n',
          '',
        ]);
      }
    });
  },
);
