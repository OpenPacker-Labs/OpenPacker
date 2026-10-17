import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPnpmProjectConfig } from './config.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function read(
  manifest: Record<string, unknown>,
  workspace?: string,
  specifiers: [string, string][] = [],
) {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-config-'));
  temps.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  if (workspace !== undefined)
    await writeFile(join(dir, 'pnpm-workspace.yaml'), workspace);
  return readPnpmProjectConfig(
    dir,
    join(dir, 'package.json'),
    new Map(specifiers),
  );
}

describe("a pnpm project's settings", () => {
  it('is empty for a project that sets none', async () => {
    const config = await read({ name: 'a' });
    expect(config.overrides.size).toBe(0);
    expect(config.catalogs.size).toBe(0);
    expect(config.supportedArchitectures).toBeUndefined();
    expect(config.patches).toEqual([]);
  });

  it("takes package.json's overrides over the workspace file's, whole, as pnpm 10 does", async () => {
    const both = await read(
      {
        resolutions: { a: '1', b: '1', c: '1', foo: '1.0.0' },
        pnpm: { overrides: { b: '2', c: '2', foo: '2.0.0' } },
      },
      'overrides:\n  c: "3"\n  d: "3"\n  foo: 3.0.0\n',
    );
    expect(Object.fromEntries(both.overrides)).toEqual({
      a: '1',
      b: '2',
      c: '2',
      foo: '2.0.0',
    });
    const fileOnly = await read({ name: 'a' }, 'overrides:\n  c: "3"\n');
    expect(Object.fromEntries(fileOnly.overrides)).toEqual({ c: '3' });
  });

  it("resolves $name to the root dependency's specifier", async () => {
    const config = await read(
      { pnpm: { overrides: { react: '$react', other: '$missing' } } },
      undefined,
      [['react', '^18.2.0']],
    );
    expect(Object.fromEntries(config.overrides)).toEqual({
      react: '^18.2.0',
      other: '$missing',
    });
  });

  it('reads the default and the named catalogs', async () => {
    const config = await read(
      { name: 'a' },
      'catalog:\n  left: ^1.0.0\ncatalogs:\n  next:\n    left: ^2.0.0\n',
    );
    expect(
      Object.fromEntries(
        [...config.catalogs].map(([k, v]) => [k, Object.fromEntries(v)]),
      ),
    ).toEqual({
      default: { left: '^1.0.0' },
      next: { left: '^2.0.0' },
    });
  });

  it("reads supportedArchitectures, from package.json's pnpm field first, and fills a missing list with the host", async () => {
    const fromManifest = await read({
      pnpm: { supportedArchitectures: { cpu: ['arm64', 'x64', 'current'] } },
    });
    expect(fromManifest.supportedArchitectures).toEqual({
      os: ['current'],
      cpu: ['arm64', 'x64', 'current'],
      libc: ['current'],
    });
    const both = await read(
      { pnpm: { supportedArchitectures: { os: ['darwin'] } } },
      'supportedArchitectures:\n  os: [linux]\n',
    );
    expect(both.supportedArchitectures?.os).toEqual(['darwin']);
    const fromFile = await read(
      { name: 'a' },
      'supportedArchitectures:\n  os: [linux]\n',
    );
    expect(fromFile.supportedArchitectures?.os).toEqual(['linux']);
  });

  it('lists the patches a project declares', async () => {
    const config = await read(
      { pnpm: { patchedDependencies: { 'a@1.0.0': 'p/a.patch' } } },
      'patchedDependencies:\n  b@2.0.0: p/b.patch\n',
    );
    expect(config.patches).toEqual(['a@1.0.0', 'b@2.0.0']);
  });

  it.each([
    [
      { pnpm: { overrides: { a: 1 } } },
      undefined,
      /package\.json pnpm\.overrides\["a"\] must be a string/u,
    ],
    [
      { pnpm: { supportedArchitectures: { os: 'linux' } } },
      undefined,
      /os must be a list of strings/u,
    ],
    [{ name: 'a' }, 'overrides: [', /pnpm-workspace\.yaml" is not valid YAML/u],
  ])(
    'refuses a setting of the wrong shape: %j',
    async (manifest, workspace, message) => {
      await expect(read(manifest, workspace)).rejects.toThrow(message);
    },
  );
});
