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
import { spawnDeclared, spawnTool } from '../src/opmx-spawn.js';
import { canSandbox } from './signal-fixture.js';

/**
 * opmx under a TMPDIR reached through a link, as every TMPDIR on macOS is
 * (/var → /private/var). The jail binds a tool's store at the real path of its
 * base and has it nowhere else, so what opmx hands the tool (node's script, a
 * native program) is named there. Spelled through the link, it does not exist
 * inside the jail.
 */

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of worlds.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A store directory under a TMPDIR that is a link, holding `files`. */
async function linkedTool(files: Record<string, string>): Promise<string> {
  const world = await mkdtemp(join(await realpath(tmpdir()), 'opmx-linked-'));
  worlds.push(world);
  await mkdir(join(world, 'real-tmp'));
  await symlink('real-tmp', join(world, 'tmp-link'), 'dir');
  vi.stubEnv('TMPDIR', join(world, 'tmp-link'));
  const tool = await mkdtemp(join(tmpdir(), 'tool-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(tool, name, '..'), { recursive: true });
    await writeFile(join(tool, name), text, { mode: 0o755 });
  }
  return tool;
}

function captured() {
  const seen = { out: '', err: '' };
  return {
    seen,
    io: {
      stdout: { write: (chunk: string) => ((seen.out += chunk), true) },
      stderr: { write: (chunk: string) => ((seen.err += chunk), true) },
    },
  };
}

describe.runIf(canSandbox)('opmx under a TMPDIR that is a link', () => {
  it('runs a node script from the store', async () => {
    const tool = await linkedTool({
      'cli.js': "process.stdout.write('ran\\n');\n",
    });
    const { seen, io } = captured();
    const exit = await spawnTool(join(tool, 'cli.js'), [], io, tool, {
      storePaths: [tool],
    });
    expect([exit, seen]).toEqual([0, { out: 'ran\n', err: '' }]);
  });

  it('runs a native program from the store', async () => {
    const tool = await linkedTool({
      'bin/tool': "#!/bin/sh\nprintf 'ran\\n'\n",
    });
    const { seen, io } = captured();
    const exit = await spawnDeclared(
      { name: 'tool', path: 'bin/tool', interpreter: 'native' },
      tool,
      [],
      io,
      tool,
    );
    expect([exit, seen]).toEqual([0, { out: 'ran\n', err: '' }]);
  });
});
