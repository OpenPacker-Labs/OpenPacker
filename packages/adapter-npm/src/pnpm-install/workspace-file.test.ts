/**
 * `pnpm-workspace.yaml` is read as the lock is: bounded, linear, no tags, no
 * links. Each case is one the first reading of the file let through (a
 * megabyte of `[` took 7.5 s and 982 MB before failing on the stack; 40,000
 * catalog entries took 89 s; a tag was a warning on stderr; a link was a raw
 * ELOOP).
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '@openpacker/adapter-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPnpmProjectConfig } from './config.js';

const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(workspace?: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-workspace-file-'));
  temps.push(dir);
  await writeFile(join(dir, 'package.json'), '{"name":"app"}');
  if (workspace !== undefined)
    await writeFile(join(dir, 'pnpm-workspace.yaml'), workspace);
  return dir;
}

const read = (dir: string) =>
  readPnpmProjectConfig(dir, join(dir, 'package.json'), new Map());

async function refusal(dir: string): Promise<ProviderError> {
  const error = await read(dir).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('pnpm-workspace.yaml, read with the bounds of the lock', () => {
  it('refuses a megabyte of [ at the nesting limit, quickly', async () => {
    const dir = await project('['.repeat(1024 * 1024 - 1));
    const started = performance.now();
    const error = await refusal(dir);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(error.code).toBe('INVALID_MANIFEST');
    expect(error.message).toMatch(
      /pnpm-workspace\.yaml" has \d+ levels of nesting, more than the limit of \d+ \(maxDepth\)/u,
    );
  }, 60_000);

  it('reads 40,000 catalog entries in linear time', async () => {
    const lines = ['catalog:'];
    for (let index = 0; index < 40_000; index += 1)
      lines.push(`  pkg-${index}: ^1.0.${index}`);
    const dir = await project(`${lines.join('\n')}\n`);
    const started = performance.now();
    const config = await read(dir);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(config.catalogs.get('default')?.size).toBe(40_000);
    expect(config.catalogs.get('default')?.get('pkg-39999')).toBe('^1.0.39999');
  }, 180_000);

  it('still finds a key written twice, wherever it is', async () => {
    const dir = await project(
      'catalog:\n  a: ^1.0.0\n  b: ^1.0.0\n  a: ^2.0.0\n',
    );
    const error = await refusal(dir);
    expect(error.code).toBe('INVALID_MANIFEST');
    expect(error.message).toMatch(/lists the key "a" twice in one mapping/u);
  });

  it('refuses a tag, and writes nothing to stderr', async () => {
    const warn = vi.spyOn(process, 'emitWarning');
    const dir = await project(
      'overrides:\n  a: !!js/function "function () { return 1 }"\n',
    );
    const error = await refusal(dir);
    expect(error.code).toBe('INVALID_MANIFEST');
    expect(error.message).toMatch(/js\/function/u);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an anchor, which pnpm does not write', async () => {
    const dir = await project('catalog:\n  a: &v ^1.0.0\n  b: *v\n');
    expect((await refusal(dir)).message).toMatch(/an anchor \(&v\)/u);
  });

  it('refuses a link, by name and escaped, as an unsafe path', async () => {
    const dir = await project();
    await writeFile(join(dir, 'real.yaml'), 'catalog:\n  a: ^1.0.0\n');
    await symlink('real.yaml', join(dir, 'pnpm-workspace.yaml'));
    const error = await refusal(dir);
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.message).toBe(
      `${JSON.stringify(join(dir, 'pnpm-workspace.yaml'))} is a symbolic link; opm ci reads pnpm-workspace.yaml itself and not what a link points at`,
    );
  });

  it('refuses bytes that are not UTF-8', async () => {
    const dir = await project(Buffer.from([0x63, 0x3a, 0x20, 0xff, 0x0a]));
    expect((await refusal(dir)).message).toMatch(/is not valid UTF-8/u);
  });

  it('reads an empty file, and one of comments only, as no settings', async () => {
    for (const text of ['', '# nothing here\n']) {
      const config = await read(await project(text));
      expect(config.overrides.size).toBe(0);
      expect(config.catalogs.size).toBe(0);
    }
  });

  it('keeps __proto__ a key like any other', async () => {
    const config = await read(
      await project('catalogs:\n  __proto__:\n    a: ^1.0.0\n'),
    );
    expect(config.catalogs.get('__proto__')?.get('a')).toBe('^1.0.0');
    expect(({} as Record<string, unknown>)['a']).toBeUndefined();
  });
});
