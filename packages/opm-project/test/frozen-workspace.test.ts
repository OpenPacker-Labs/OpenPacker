import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireAdapterRegistry } from '../src/adapters.js';
import { prepareFrozenWorkspace } from '../src/frozen-workspace.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(
  members: Record<string, Record<string, unknown>>,
  root: Record<string, unknown> = { workspaces: ['packages/*'] },
) {
  const dir = await mkdtemp(join(tmpdir(), 'frozen-ws-prepare-'));
  temps.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'app', ...root }),
  );
  for (const [path, manifest] of Object.entries(members)) {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, path, 'package.json'), JSON.stringify(manifest));
  }
  return dir;
}

const npm = () => requireAdapterRegistry().projectFormatFor('npm');
const members = {
  'packages/one': { name: '@s/one', version: '1.0.0' },
  'packages/two': { name: 'two', version: '1.0.0' },
  'libs/three': { name: 'three', version: '1.0.0' },
};

describe('prepareFrozenWorkspace', () => {
  it('reads the workspace the project declares, and asks for all of it by default', async () => {
    const dir = await project(members, {
      workspaces: ['packages/*', 'libs/*'],
    });
    const input = await prepareFrozenWorkspace(dir, await npm());
    expect(input?.scope).toEqual({ kind: 'all' });
    expect((await input?.disk())?.map((m) => [m.dir, m.name])).toEqual([
      ['', 'app'],
      ['libs/three', 'three'],
      ['packages/one', '@s/one'],
      ['packages/two', 'two'],
    ]);
  });

  it('has nothing to read in a project that declares no workspace', async () => {
    const dir = await project({}, {});
    const input = await prepareFrozenWorkspace(dir, await npm());
    expect(input?.scope).toEqual({ kind: 'all' });
    expect(await input?.disk()).toEqual([]);
  });

  it('reads --workspace as npm does: a name, a directory, or the directory above', async () => {
    const dir = await project(members, {
      workspaces: ['packages/*', 'libs/*'],
    });
    const select = async (...names: string[]) =>
      (await prepareFrozenWorkspace(dir, await npm(), { select: names }))
        ?.scope;
    expect(await select('@s/one')).toEqual({
      kind: 'members',
      dirs: ['packages/one'],
      includeRoot: false,
    });
    expect(await select('libs/three', 'two')).toMatchObject({
      dirs: ['libs/three', 'packages/two'],
    });
    expect(await select('packages')).toMatchObject({
      dirs: ['packages/one', 'packages/two'],
    });
  });

  it("refuses a selection that matches no member, by npm's words", async () => {
    const dir = await project(members);
    await expect(
      prepareFrozenWorkspace(dir, await npm(), { select: ['absent'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: 'No workspaces found: --workspace=absent',
    });
  });

  it('selects every member, and not the root, for --workspaces', async () => {
    const dir = await project(members);
    expect(
      (await prepareFrozenWorkspace(dir, await npm(), { all: true }))?.scope,
    ).toEqual({
      kind: 'members',
      dirs: ['packages/one', 'packages/two'],
      includeRoot: false,
    });
    expect(
      (
        await prepareFrozenWorkspace(dir, await npm(), {
          all: true,
          includeRoot: true,
        })
      )?.scope,
    ).toMatchObject({ includeRoot: true });
  });

  it('changes nothing for --include-workspace-root alone, as npm does', async () => {
    const dir = await project(members);
    expect(
      (await prepareFrozenWorkspace(dir, await npm(), { includeRoot: true }))
        ?.scope,
    ).toEqual({ kind: 'all' });
  });

  it("asks for the project's own dependencies with --workspaces=false", async () => {
    const dir = await project(members);
    expect(
      (await prepareFrozenWorkspace(dir, await npm(), { ignore: true }))?.scope,
    ).toEqual({ kind: 'root' });
  });

  it('refuses what cannot go together or has nothing to apply to', async () => {
    const dir = await project(members);
    await expect(
      prepareFrozenWorkspace(dir, await npm(), { ignore: true, all: true }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    const bare = await project({}, {});
    await expect(
      prepareFrozenWorkspace(bare, await npm(), { all: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringMatching(/declares none/u),
    });
    const cargo = await requireAdapterRegistry().projectFormatFor('cargo');
    expect(await prepareFrozenWorkspace(bare, cargo)).toBeUndefined();
    await expect(
      prepareFrozenWorkspace(bare, cargo, { select: ['x'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringMatching(/cargo projects have no workspaces/u),
    });
  });

  it("names an unsafe workspace in opm's own vocabulary", async () => {
    const dir = await project(
      { 'packages/a': { name: 'a' }, 'packages/b': { name: 'a' } },
      { workspaces: ['packages/*'] },
    );
    // Nothing is read until the adapter asks, or a selection needs the members.
    const input = await prepareFrozenWorkspace(dir, await npm());
    await expect(input?.disk()).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
      message: expect.stringMatching(/Two workspace members are named "a"/u),
    });
    await expect(
      prepareFrozenWorkspace(dir, await npm(), { select: ['a'] }),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });
});
