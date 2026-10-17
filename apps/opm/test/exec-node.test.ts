import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeProject } from './run-fixture.js';
import { contextWith, go } from './workspace-fixture.js';

async function script(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe('opm exec node', () => {
  it('starts the Node that runs opm when no .bin has a node', async () => {
    const root = await makeProject({});
    const ran = await go('exec', ['node', '-p', '1 + 1'], root);
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out).toBe('2\n');
  });

  it('is the Node opm runs on, whatever node is first on PATH', async () => {
    const root = await makeProject({});
    await script(join(root, 'decoy'), 'node', 'echo decoy node');
    const ran = await go(
      'exec',
      ['node', '-p', 'process.execPath'],
      root,
      contextWith({
        PATH: [join(root, 'decoy'), process.env.PATH ?? ''].join(delimiter),
      }),
    );
    expect(ran.out.trim()).toBe(process.execPath);
  });

  it.skipIf(process.platform === 'win32')(
    'answers with the execPath the context names',
    async () => {
      const root = await makeProject({});
      const fake = await script(
        join(root, 'bin'),
        'my-node',
        'echo "fake node: $@"',
      );
      const ran = await go(
        'exec',
        ['node', 'a', 'b'],
        root,
        contextWith({}, { execPath: fake }),
      );
      expect(ran.out).toBe('fake node: a b\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prefers a node in node_modules/.bin, as for any bin',
    async () => {
      const root = await makeProject({});
      await script(
        join(root, 'node_modules', '.bin'),
        'node',
        'echo project node',
      );
      const ran = await go('exec', ['node'], root);
      expect(ran.out).toBe('project node\n');
    },
  );

  it('is the only name that gets this: another program on PATH is still not found', async () => {
    const root = await makeProject({});
    const ran = await go(
      'exec',
      [process.platform === 'win32' ? 'cmd' : 'sh', '-c', 'true'],
      root,
    );
    expect(ran.status).toBe(4);
    expect(ran.err).toContain('exec never fetches or searches PATH');
  });
});
