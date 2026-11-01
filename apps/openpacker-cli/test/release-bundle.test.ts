import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const releaseDir = join(repoRoot, 'apps/openpacker-cli/release');

async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (typeof failed.code === 'number') {
      return {
        code: failed.code,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      };
    }
    throw error;
  }
}

function expectExit(
  result: { code: number; stdout: string; stderr: string },
  code = 0,
) {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(code);
}

describe('publishable CLI bundle', () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('packs the bundle, installs it, and prints usage', async () => {
    expectExit(
      await run('npm', ['run', 'bundle', '--workspace', '@openpacker/cli'], {
        cwd: repoRoot,
      }),
    );

    const packDir = await mkdtemp(join(tmpdir(), 'openpacker-pack-'));
    temps.push(packDir);
    const packed = await run(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
      { cwd: releaseDir },
    );
    expectExit(packed);
    const start = packed.stdout.indexOf('[');
    const info = JSON.parse(packed.stdout.slice(start)) as Array<{
      filename: string;
      name: string;
    }>;
    expect(info[0]?.name).toBe('@openpacker/cli');
    const tgz = join(packDir, info[0].filename);

    const prefix = await mkdtemp(join(tmpdir(), 'openpacker-prefix-'));
    temps.push(prefix);
    expectExit(
      await run('npm', ['install', '-g', tgz], {
        env: { ...process.env, npm_config_prefix: prefix },
      }),
    );

    const bin =
      process.platform === 'win32'
        ? join(prefix, 'openpacker.cmd')
        : join(prefix, 'bin', 'openpacker');
    const help = await run(bin, ['--help']);
    expectExit(help);
    expect(help.stdout).toContain('Usage');
  }, 300_000);
});
