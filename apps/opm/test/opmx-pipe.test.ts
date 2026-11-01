/**
 * `opmx tool | head -1`: once `head` has its line it goes, and opmx's next
 * write to the pipe fails with EPIPE. Nothing listened for that, so opmx went
 * on reading the tool, or ended on an error of its own, while a tool that
 * writes forever kept writing. A shell pipeline ends such a writer by
 * SIGPIPE: opmx now stops forwarding, ends the tool's tree by SIGPIPE and then
 * as it ends any run, and exits 141, as a writer SIGPIPE ended does.
 *
 * This runs the build output: `npm run build -w @openpacker/opm` first.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appRoot } from './bins-fixture.js';
import {
  INSTALLED_TIMEOUT_MS,
  binPackage,
  installedProject,
} from './installed-fixture.js';
import { canSandbox, withMarker } from './signal-fixture.js';

const opmx = join(appRoot, 'dist', 'opmx-main.js');

/** `yes`: writes lines for as long as it runs, as fast as it is read. */
const yes = binPackage(
  'yes',
  `const lines = 'y\\n'.repeat(512);
const write = () => {
  while (process.stdout.write(lines));
  process.stdout.once('drain', write);
};
write();
`,
);

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** `script` in bash, in `cwd`, with `env`: what it wrote, and its status. */
function bash(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; out: string; err: string }>(
    (settle, fail) => {
      const child = spawn('bash', ['-c', script], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        err += chunk;
      });
      child.on('error', fail);
      child.on('close', (status) => settle({ status, out, err }));
    },
  );
}

describe.runIf(canSandbox)(
  'opmx writing to a pipe whose reader has gone',
  { timeout: INSTALLED_TIMEOUT_MS },
  () => {
    it('ends the tool as a shell pipeline would, and exits 141', async () => {
      expect(existsSync(opmx), 'run: npm run build -w @openpacker/opm').toBe(
        true,
      );
      const root = await installedProject([yes]);
      const own = await mkdtemp(join(tmpdir(), 'opmx-pipe-own-'));
      temps.push(own);
      for (const name of ['cache', 'config', 'data', 'state'])
        await mkdir(join(own, name));
      // Among the tool's arguments, to find any of it still running after.
      const marker = `opmx-pipe-${process.pid}-${Date.now()}`;
      const ran = await bash(
        'node "$OPMX" yes -- "$MARKER" | head -1; echo "opmx ${PIPESTATUS[0]}" >&2',
        root,
        {
          PATH: process.env.PATH,
          HOME: own,
          TMPDIR: own,
          XDG_CACHE_HOME: join(own, 'cache'),
          XDG_CONFIG_HOME: join(own, 'config'),
          XDG_DATA_HOME: join(own, 'data'),
          XDG_STATE_HOME: join(own, 'state'),
          OPM_STORE_HOME: 'off',
          NODE_NO_WARNINGS: '1',
          OPMX: opmx,
          MARKER: marker,
        },
      );
      expect([ran.status, ran.out, ran.err]).toEqual([0, 'y\n', 'opmx 141\n']);
      expect(withMarker(marker)).toEqual([]);
    });
  },
);

describe.skipIf(canSandbox)(
  'opmx writing to a pipe whose reader has gone',
  () => {
    it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
  },
);
