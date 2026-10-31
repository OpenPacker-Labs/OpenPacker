import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedProject } from '@openpacker/adapter-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chooseLock,
  chooseProjectLock,
  managerOf,
  packageManagerOf,
} from './lock-choice.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(...locks: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lock-choice-'));
  temps.push(dir);
  for (const lock of locks) await writeFile(join(dir, lock), '');
  return dir;
}

const never = async (): Promise<string | undefined> => {
  throw new Error('packageManager was read although one lock decides');
};

describe('chooseLock', () => {
  it('takes the only lock the project has, without reading packageManager', async () => {
    expect(await chooseLock(await project('pnpm-lock.yaml'), never)).toEqual(
      expect.objectContaining({ kind: 'pnpm' }),
    );
    expect(await chooseLock(await project('package-lock.json'), never)).toEqual(
      expect.objectContaining({ kind: 'npm' }),
    );
  });

  it('names both files when there is no lock', async () => {
    await expect(chooseLock(await project(), never)).rejects.toThrow(
      /No package-lock\.json or pnpm-lock\.yaml/u,
    );
  });

  it.each([
    ['pnpm@10.28.0', 'pnpm'],
    ['pnpm@10.28.0+sha512.0123abcd', 'pnpm'],
    ['npm@10.9.4', 'npm'],
    ['pnpm', 'pnpm'],
  ] as const)(
    'lets packageManager %s decide between two',
    async (field, kind) => {
      const dir = await project('pnpm-lock.yaml', 'package-lock.json');
      expect((await chooseLock(dir, async () => field)).kind).toBe(kind);
    },
  );

  it.each([
    [undefined, /has no packageManager field/u],
    ['yarn@4.1.0', /names yarn as its packageManager/u],
    ['', /has no packageManager field/u],
  ] as const)(
    'refuses two locks when packageManager is %j, naming both',
    async (field, message) => {
      const dir = await project('pnpm-lock.yaml', 'package-lock.json');
      const refusal = chooseLock(dir, async () => field);
      await expect(refusal).rejects.toThrow(message);
      await expect(refusal).rejects.toThrow(
        /both package-lock\.json and pnpm-lock\.yaml/u,
      );
      await expect(refusal).rejects.toMatchObject({ code: 'INVALID_LOCKFILE' });
    },
  );
});

describe('managerOf', () => {
  it('reads the name of the manager, whatever follows it', () => {
    expect(managerOf('pnpm@10.28.0+sha512.abc')).toBe('pnpm');
    expect(managerOf('yarn@4.1.0')).toBe('yarn');
    expect(managerOf('bun')).toBe('bun');
    expect(managerOf('@scoped/x@1')).toBe('@scoped/x');
    expect(managerOf('')).toBeUndefined();
    expect(managerOf(undefined)).toBeUndefined();
  });
});

describe('the packageManager of a project', () => {
  async function manifest(text: string): Promise<DetectedProject> {
    const dir = await project('pnpm-lock.yaml', 'package-lock.json');
    await writeFile(join(dir, 'package.json'), text);
    return { root: dir, manifestPath: join(dir, 'package.json') };
  }

  it('is read from package.json when it is text', async () => {
    const detected = await manifest('{"packageManager":"pnpm@10.28.0"}');
    expect(await packageManagerOf(detected.manifestPath)).toBe('pnpm@10.28.0');
    expect((await chooseProjectLock(detected)).kind).toBe('pnpm');
  });

  it.each([
    '{"packageManager":5}',
    '{"packageManager":null}',
    '{}',
    'null',
    'not json',
  ])('is nothing in %s, and then two locks are refused', async (text) => {
    const detected = await manifest(text);
    expect(await packageManagerOf(detected.manifestPath)).toBeUndefined();
    await expect(chooseProjectLock(detected)).rejects.toThrow(
      /has no packageManager field/u,
    );
  });

  it('is nothing when there is no package.json', async () => {
    expect(
      await packageManagerOf(join(await project(), 'package.json')),
    ).toBeUndefined();
  });
});
