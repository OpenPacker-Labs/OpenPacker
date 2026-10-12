import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DetectedProject,
  FrozenLock,
  FrozenLockOptions,
  WorkspaceMember,
} from '@openpacker/adapter-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fixtureBytes,
  type FixtureName,
} from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { readFrozenPnpmLock } from './frozen.js';
import { buildPnpmModel } from './model.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const LINUX = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;

/** The members the lock's importers stand for, named by the links that point at them. */
function membersOf(text: Uint8Array): WorkspaceMember[] {
  const model = buildPnpmModel(readPnpmLock(text).lock);
  const names = new Map<string, string>();
  for (const top of model.tops.values())
    for (const edge of top.edges)
      if (edge.kind === 'link' && edge.memberId !== undefined)
        names.set(edge.memberId, edge.as);
  return [...model.tops.values()].map((top) => ({
    dir: top.dir,
    root: top.dir === '',
    name:
      top.dir === ''
        ? 'project'
        : (names.get(top.id) ?? top.dir.split('/').at(-1)!),
    nameFromDirectory: false,
    manifest: {
      name: undefined,
      version: undefined,
      private: true,
      dependencies: new Map(),
      devDependencies: new Map(),
      optionalDependencies: new Map(),
      peerDependencies: new Map(),
      optionalPeers: new Set(),
      workspaces: undefined,
      bin: {},
    },
  }));
}

async function read(
  fixture: FixtureName | { text: string },
  options: Partial<FrozenLockOptions> = {},
): Promise<FrozenLock> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-plan-'));
  temps.push(dir);
  const bytes =
    typeof fixture === 'string'
      ? fixtureBytes(fixture)
      : new TextEncoder().encode(fixture.text);
  const lockPath = join(dir, 'pnpm-lock.yaml');
  await writeFile(lockPath, bytes);
  await mkdir(dir, { recursive: true });
  const project: DetectedProject = {
    root: dir,
    manifestPath: join(dir, 'package.json'),
  };
  const members = membersOf(bytes);
  return readFrozenPnpmLock(
    project,
    {
      target: LINUX,
      omit: new Set(),
      workspace: { disk: async () => members, scope: { kind: 'all' } },
      ...options,
    },
    lockPath,
  );
}

describe.each([
  'ai-bdd.pnpm-lock.yaml',
  'hobo.cut.pnpm-lock.yaml',
  'opensesame.cut.pnpm-lock.yaml',
] as const)('the plan of %s on linux x64', (name) => {
  it('installs every instance the independent walk installs, each at one place or more', async () => {
    const lock = await read(name);
    expect(lock.refused).toEqual([]);
    const model = buildPnpmModel(readPnpmLock(fixtureBytes(name)).lock);
    const instances = new Set(lock.packages.map((pkg) => pkg.instance));
    expect(instances.size).toBeGreaterThan(250);
    expect(
      [...instances].every(
        (key) => key !== undefined && model.instances.has(key),
      ),
    ).toBe(true);
    expect(lock.packages.length).toBeGreaterThanOrEqual(instances.size);
    expect(new Set(lock.packages.map((pkg) => pkg.path)).size).toBe(
      lock.packages.length,
    );
  });

  it('gives every place a source that is the registry, an integrity, and the package under its install name', async () => {
    const lock = await read(name);
    for (const pkg of lock.packages) {
      expect(pkg.sourceKind).toBe('registry');
      expect(pkg.integrity).toMatch(/^sha512-/u);
      expect(pkg.source).toBe(
        `https://registry.npmjs.org/${pkg.packageName}/-/${pkg.packageName.split('/').at(-1)}-${pkg.version}.tgz`,
      );
      expect(pkg.path.endsWith(`node_modules/${pkg.name}`)).toBe(true);
    }
  });

  it('links each member that is linked, once, at the project', async () => {
    const lock = await read(name);
    const model = buildPnpmModel(readPnpmLock(fixtureBytes(name)).lock);
    const linked = new Set(
      [...model.tops.values()].flatMap((top) =>
        top.edges.flatMap((edge) => (edge.kind === 'link' ? [edge.as] : [])),
      ),
    );
    expect(
      lock.workspace!.layout.links.map((link) => link.path).sort(),
    ).toEqual([...linked].map((link) => `node_modules/${link}`).sort());
    expect(lock.workspace!.memberDirs).toHaveLength(
      [...model.tops.keys()].filter((id) => id !== '.').length,
    );
  });
});

describe('the plan of the ai-bdd lock', () => {
  it('installs what the independent walk says on linux x64, and says what it leaves out', async () => {
    const lock = await read('ai-bdd.pnpm-lock.yaml');
    expect(new Set(lock.packages.map((pkg) => pkg.instance)).size).toBe(353);
    expect(
      lock.skipped.filter((skip) => skip.kind === 'platform'),
    ).toHaveLength(40);
  });

  it("keeps each importer's direct dependencies in its own node_modules", async () => {
    const lock = await read('ai-bdd.pnpm-lock.yaml');
    const direct = lock.packages.filter((pkg) => pkg.direct);
    expect(direct.some((pkg) => pkg.path === 'node_modules/typescript')).toBe(
      true,
    );
    expect(
      direct.some(
        (pkg) =>
          pkg.path === 'packages/sdk/node_modules/zod' ||
          pkg.path.startsWith('packages/sdk/node_modules/'),
      ),
    ).toBe(true);
    for (const pkg of direct)
      expect(pkg.path.match(/node_modules/gu)).toHaveLength(1);
  });

  it('puts the one package of two sets of peers in two places and names its instances', async () => {
    const lock = await read('hobo.cut.pnpm-lock.yaml');
    const vitest = lock.packages.filter((pkg) => pkg.packageName === 'vitest');
    expect(new Set(vitest.map((pkg) => pkg.instance)).size).toBeGreaterThan(1);
    expect(new Set(vitest.map((pkg) => `${pkg.integrity}`)).size).toBe(1);
  });

  it('leaves the other platforms of an alias out and installs the one for this machine', async () => {
    const lock = await read('hobo.cut.pnpm-lock.yaml');
    const codex = lock.packages.filter(
      (pkg) => pkg.packageName === '@openai/codex' && pkg.version.includes('-'),
    );
    expect(codex.map((pkg) => pkg.name)).toEqual(['@openai/codex-linux-x64']);
    expect(codex[0]!.path).toMatch(/node_modules\/@openai\/codex-linux-x64$/u);
  });
});
