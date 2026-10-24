import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockBackend } from './backends/mock.js';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { runInSandbox } from './run.js';
import type { SandboxBackend } from './types.js';

/**
 * A caller that shows a tool to a person (opmx) is handed its output as the
 * tool writes it, through `output`, rather than all of it once the tool ends:
 * a server that prints a line and keeps running showed nothing. Nothing is
 * kept in the outcome, so the policy's byte limits, which bound what is kept,
 * do not end a tree whose output is handed on.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'op-sandbox-output-'));
  roots.push(root);
  return root;
}

const decoder = () => {
  const seen = { stdout: '', stderr: '' };
  return {
    seen,
    output: {
      stdout: (chunk: Uint8Array) =>
        (seen.stdout += Buffer.from(chunk).toString('utf8')),
      stderr: (chunk: Uint8Array) =>
        (seen.stderr += Buffer.from(chunk).toString('utf8')),
    },
  };
};

async function until(test: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; )
    if (test()) return;
    else await sleep(25);
}

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

const backends: [string, () => SandboxBackend][] = [
  ['the mock backend', () => createMockBackend()],
  ...(bwrapReady
    ? [['native bwrap', () => nativeBackend!] as [string, () => SandboxBackend]]
    : []),
];

describe.each(backends)(
  'output handed on as it is written, by %s',
  (_, backend) => {
    it('reaches the caller while the process still runs, and is not kept', async () => {
      const root = project();
      const { seen, output } = decoder();
      const stop = new AbortController();
      const run = runInSandbox({
        argv: ['/bin/sh', '-c', 'echo ready; echo warm >&2; exec sleep 600'],
        cwd: root,
        policy: { enabled: true, mode: 'fail-closed', required: true },
        readwritePaths: [],
        readonlyPaths: [root],
        backend: backend(),
        signal: stop.signal,
        output,
      });
      await until(() => seen.stdout !== '' && seen.stderr !== '');
      // What the process had written by the time it was stopped.
      const before = { ...seen };
      stop.abort();
      const outcome = await run;
      expect(before).toEqual({ stdout: 'ready\n', stderr: 'warm\n' });
      expect(outcome.exitCode).toBe(124);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toBe('\nopenpacker sandbox: process aborted\n');
    }, 30_000);

    it('hands on all of it, past the byte limits, and lets the process run on', async () => {
      // More than the default limits of what is kept: 1 MiB a stream, 2 MiB
      // in all. They bound memory, and output handed on is not kept.
      const root = project();
      const counted = { stdout: 0, stderr: 0 };
      const outcome = await runInSandbox({
        argv: [
          '/bin/sh',
          '-c',
          'head -c 3145728 /dev/zero; head -c 1572864 /dev/zero >&2; echo end',
        ],
        cwd: root,
        policy: { enabled: true, mode: 'fail-closed', required: true },
        readwritePaths: [],
        readonlyPaths: [root],
        backend: backend(),
        output: {
          stdout: (chunk) => (counted.stdout += chunk.byteLength),
          stderr: (chunk) => (counted.stderr += chunk.byteLength),
        },
      });
      expect(counted).toEqual({ stdout: 3_145_728 + 4, stderr: 1_572_864 });
      expect(outcome).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
      expect(outcome.outputLimitExceeded).toBeUndefined();
    }, 30_000);
  },
);

describe('output kept in the outcome', () => {
  it('is cut at the byte limits, and the tree is ended past them', async () => {
    const outcome = await runInSandbox({
      argv: ['/bin/sh', '-c', 'printf "%3000s" x; exec sleep 600'],
      cwd: project(),
      policy: {
        enabled: true,
        mode: 'fail-closed',
        required: true,
        maximumStdoutBytes: 1024,
      },
      readwritePaths: [],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome).toMatchObject({
      exitCode: 125,
      stdout: ' '.repeat(1024),
      stderr: '\nopenpacker sandbox: stdout output limit exceeded\n',
      outputLimitExceeded: 'stdout',
    });
  }, 30_000);

  it('is what a caller with no sink gets, as before', async () => {
    const outcome = await runInSandbox({
      argv: ['/bin/sh', '-c', 'echo kept; echo also >&2'],
      cwd: project(),
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect([outcome.stdout, outcome.stderr]).toEqual(['kept\n', 'also\n']);
  });
});
