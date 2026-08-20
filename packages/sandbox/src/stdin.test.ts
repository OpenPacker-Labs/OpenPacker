import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockBackend } from './backends/mock.js';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { runInSandbox } from './run.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'op-sandbox-stdin-'));
  roots.push(root);
  return root;
}

describe('sandbox stdin plumbing', () => {
  it('delivers bounded stdin bytes through the mock backend', async () => {
    const root = project();
    const outcome = await runInSandbox({
      argv: ['cat'],
      cwd: root,
      stdin: new TextEncoder().encode('{"request":true}'),
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('{"request":true}');
  });

  it('leaves stdin closed when no bytes are given', async () => {
    const root = project();
    const marker = join(root, 'stdin-open');
    const outcome = await runInSandbox({
      argv: [
        '/bin/sh',
        '-c',
        `read -t 1 line && printf open > ${JSON.stringify(marker)}; exit 0`,
      ],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [root],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.exitCode).toBe(0);
    await expect(
      import('node:fs/promises').then((fs) => fs.stat(marker)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

describe.skipIf(!bwrapReady)('sandbox stdin under native bwrap', () => {
  it('delivers stdin inside the jail', async () => {
    const root = project();
    writeFileSync(join(root, 'keep'), 'x');
    const outcome = await runInSandbox({
      argv: ['cat'],
      cwd: root,
      stdin: new TextEncoder().encode('jailed-bytes'),
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [root],
      backend: nativeBackend!,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('jailed-bytes');
  });
});
