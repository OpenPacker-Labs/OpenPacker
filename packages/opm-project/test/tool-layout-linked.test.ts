import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layOutTool, runSandboxedPackageProcess } from '../src/index.js';

/**
 * A tool laid out under a TMPDIR reached through a link, as every TMPDIR on
 * macOS is (/var → /private/var). The jail binds the layout at the real path
 * of its base and has it nowhere else, so the layout is made, and its bin
 * named, there. Spelled through the link, node was handed a path the jail
 * does not have: "Cannot find module".
 */

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of worlds.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

const DIGEST = '1'.repeat(64);

describe.runIf(canSandbox)(
  'a tool laid out under a TMPDIR that is a link',
  () => {
    it('runs, its layout and its bin where its jail has them', async () => {
      const world = await mkdtemp(
        join(await realpath(tmpdir()), 'opm-layout-linked-'),
      );
      worlds.push(world);
      await mkdir(join(world, 'real-tmp'));
      await symlink('real-tmp', join(world, 'tmp-link'), 'dir');
      vi.stubEnv('TMPDIR', join(world, 'tmp-link'));

      const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-'));
      const storePath = join(cacheRoot, '.opm', 'store', `sha256-${DIGEST}`);
      await mkdir(join(storePath, 'package'), { recursive: true });
      await writeFile(
        join(storePath, 'package', 'package.json'),
        JSON.stringify({ name: 'tool', version: '1.0.0', bin: 'cli.js' }),
      );
      await writeFile(
        join(storePath, 'package', 'cli.js'),
        "process.stdout.write('ran\\n');\n",
      );
      const layout = await layOutTool({
        cacheRoot,
        tool: 'pkg:npm/tool@1.0.0',
        closure: [
          {
            exactPurl: 'pkg:npm/tool@1.0.0',
            digest: `sha256:${DIGEST}`,
            size: 1,
            source: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz',
            storePath,
          },
        ],
      });
      try {
        expect(layout.root.startsWith(join(world, 'real-tmp', ''))).toBe(true);
        const outcome = await runSandboxedPackageProcess({
          timeoutMs: 0,
          argv: [process.execPath, layout.entry('cli.js')],
          cwd: cacheRoot,
          storePaths: [layout.root],
        });
        expect([outcome.exitCode, outcome.stdout, outcome.stderr]).toEqual([
          0,
          'ran\n',
          '',
        ]);
      } finally {
        await layout.dispose();
      }
    });
  },
);
