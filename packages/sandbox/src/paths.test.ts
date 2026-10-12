/**
 * The grants every sandboxed run opens before it starts. Each one is opened
 * from "/" one retained, no-follow ancestor at a time; on macOS that is libc
 * `openat` and never a path joined onto `/dev/fd/N`, which names nothing there
 * (ADR 0045). `sandbox.libc-at.test.ts` runs this file with the libc backend.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDirChild } from '@openpacker/project-io';
import { afterEach, describe, expect, it } from 'vitest';
import { JailPathError } from './index.js';
import { openStableJailPath } from './paths.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), 'op-sandbox-paths-'),
  );
  roots.push(dir);
  return dir;
}

function spoofPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  return () => {
    if (original) Object.defineProperty(process, 'platform', original);
  };
}

describe('openStableJailPath', () => {
  it('opens a directory grant and a file grant', async () => {
    const dir = await root();
    await mkdir(join(dir, 'tree', 'inner'), { recursive: true });
    await writeFile(join(dir, 'tree', 'inner', 'file'), 'bytes');
    const folder = await openStableJailPath(join(dir, 'tree', 'inner'));
    try {
      expect((await folder.stat()).isDirectory()).toBe(true);
    } finally {
      await folder.close();
    }
    const file = await openStableJailPath(join(dir, 'tree', 'inner', 'file'));
    try {
      expect((await file.stat()).size).toBe(5);
    } finally {
      await file.close();
    }
  });

  it('keeps naming the directory that was checked after its pathname is replaced', async () => {
    const dir = await root();
    const grant = join(dir, 'grant');
    await mkdir(grant);
    await writeFile(join(grant, 'authorized'), '');
    const handle = await openStableJailPath(grant, 'sandbox bind');
    try {
      await rename(grant, join(dir, 'moved'));
      await mkdir(grant);
      await writeFile(join(grant, 'replacement'), '');
      expect(await readDirChild(handle)).toEqual(['authorized']);
    } finally {
      await handle.close();
    }
  });

  it('opens nothing for a missing grant', async () => {
    const dir = await root();
    await expect(
      openStableJailPath(join(dir, 'missing', 'deeper')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a grant that is neither a regular file nor a directory', async () => {
    const dir = await root();
    try {
      execFileSync('mkfifo', [join(dir, 'pipe')]);
    } catch {
      return;
    }
    const refusal = await openStableJailPath(
      join(dir, 'pipe'),
      'sandbox bind',
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(JailPathError);
    expect(String(refusal)).toMatch(/regular file or directory/u);
  });

  it('is refused early on a platform with no handle-relative open', async () => {
    const dir = await root();
    const restore = spoofPlatform('win32');
    try {
      await expect(openStableJailPath(dir, 'sandbox bind')).rejects.toThrow(
        /unavailable on this platform/u,
      );
    } finally {
      restore();
    }
  });
});
