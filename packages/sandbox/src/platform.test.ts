/**
 * What a host cannot do is said before anything is opened or run. The platform
 * is spoofed, as project-io's selection tests do, because the refusals are for
 * hosts this suite does not run on.
 */

import { mkdtemp, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockBackend,
  reopenExecutableAuthority,
  runInSandbox,
  SandboxBackendError,
  type SandboxBackend,
} from './index.js';
import {
  containmentWithdrawnNote,
  executableAuthorityRefusal,
  platformLabel,
} from './platform.js';

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function spoofPlatform(value: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  restores.push(() => {
    if (original) Object.defineProperty(process, 'platform', original);
  });
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'op-sandbox-platform-'));
  roots.push(root);
  return root;
}

/** A backend that must never be reached, and says so. */
const unreachable: SandboxBackend = {
  id: 'mock',
  run: () => Promise.reject(new Error('backend reached')),
};

describe('platform refusals', () => {
  it('names the platform', () => {
    expect([
      platformLabel('darwin'),
      platformLabel('win32'),
      platformLabel('linux'),
      platformLabel('freebsd'),
    ]).toEqual(['macOS', 'Windows', 'Linux', 'freebsd']);
  });

  it('has nothing to refuse on Linux', () => {
    expect(executableAuthorityRefusal('linux')).toBeUndefined();
    expect(containmentWithdrawnNote('linux')).toBeUndefined();
  });

  it('says what macOS lacks and where to run instead', () => {
    const refusal = executableAuthorityRefusal('darwin');
    expect(refusal).toMatch(
      /Cannot run an approved executable snapshot on macOS/u,
    );
    expect(refusal).toMatch(/fexecve/u);
    expect(refusal).toMatch(/\/dev\/fd\/N is a descriptor filesystem/u);
    expect(refusal).toMatch(/Run this on a Linux host/u);
    const note = containmentWithdrawnNote('darwin');
    expect(note).toMatch(/withdrawn on macOS \(ADR 0036\)/u);
    expect(note).toMatch(/Bubblewrap on Linux/u);
    expect(note).toMatch(/`opm exec <bin>`/u);
  });

  it('says it of Windows without borrowing macOS facts', () => {
    const refusal = executableAuthorityRefusal('win32');
    expect(refusal).toMatch(/on Windows/u);
    expect(refusal).not.toMatch(/\/dev\/fd/u);
  });
});

describe('an executable snapshot off Linux', () => {
  it('is refused by runInSandbox before a backend is reached or a handle opened', async () => {
    const root = await project();
    spoofPlatform('darwin');
    const error = await runInSandbox({
      argv: ['/approved/tool'],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [],
      executableAuthority: { fd: 99, path: '/approved/tool' },
      backend: unreachable,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxBackendError);
    expect(error).toMatchObject({ code: 'EXECUTABLE_AUTHORITY_UNSUPPORTED' });
    expect(String(error)).toMatch(/on macOS/u);
  });

  it('is refused by the mock backend too, not given a /dev/fd/N argv', async () => {
    const root = await project();
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    spoofPlatform('darwin');
    try {
      const error = await createMockBackend()
        .run({
          argv: ['/approved/tool'],
          cwd: root,
          hostEnv: {},
          env: {},
          readwritePaths: [],
          readonlyPaths: [],
          network: false,
          profile: 'package-exec',
          maximumStdoutBytes: 1_024,
          maximumStderrBytes: 1_024,
          maximumOutputBytes: 2_048,
          executableAuthority: { fd: handle.fd, path: '/approved/tool' },
        })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'EXECUTABLE_AUTHORITY_UNSUPPORTED' });
    } finally {
      await handle.close();
    }
  });

  it('is refused when asked to reopen as a Linux descriptor', async () => {
    spoofPlatform('darwin');
    await expect(reopenExecutableAuthority(3)).rejects.toMatchObject({
      code: 'EXECUTABLE_AUTHORITY_UNSUPPORTED',
    });
  });

  it('still tells an invalid descriptor from an unsupported platform on Linux', async () => {
    await expect(reopenExecutableAuthority(-1)).rejects.toMatchObject({
      code: 'INVALID_FD_AUTHORITY',
    });
  });
});

describe('a run with no containment off Linux', () => {
  it('fails closed with the platform, the reason and what to run instead', async () => {
    const root = await project();
    spoofPlatform('darwin');
    // No native jail exists there and none is asked for by name, which is the
    // macOS outcome when the MXC SDK is absent: no backend, so exit 78 before
    // any grant is opened.
    const outcome = await runInSandbox({
      argv: ['/bin/true'],
      cwd: root,
      policy: {
        enabled: true,
        mode: 'fail-closed',
        required: true,
        prefer: 'native',
      },
      readwritePaths: [],
      readonlyPaths: [],
    });
    expect(outcome.exitCode).toBe(78);
    expect(outcome.enforced).toBe(false);
    expect(outcome.stderr).toMatch(/withdrawn on macOS \(ADR 0036\)/u);
    expect(outcome.stderr).toMatch(/Run this on a Linux host/u);
    expect(outcome.stderr).toMatch(/`opm exec <bin>`/u);
  });

  it('says nothing about macOS on Linux', async () => {
    const root = await project();
    const outcome = await runInSandbox({
      argv: ['/bin/true'],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [],
      backend: createMockBackend({ unavailable: true }),
    });
    expect(outcome.exitCode).toBe(78);
    expect(outcome.stderr).not.toMatch(/withdrawn on/u);
  });
});
