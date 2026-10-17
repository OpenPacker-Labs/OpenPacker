import type { FrozenLock, FrozenLockOptions } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import {
  fixtureBytes,
  type FixtureName,
} from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { worldOf } from './frozen-support.js';
import { buildPnpmModel } from './model.js';

async function read(
  fixture: FixtureName,
  options: Partial<FrozenLockOptions> = {},
): Promise<FrozenLock> {
  return (await worldOf(fixtureBytes(fixture))).read(options);
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

describe('--omit peer', () => {
  it('is refused for a pnpm lock, before the project is read, saying why', async () => {
    const error = await read('ai-bdd.pnpm-lock.yaml', {
      omit: new Set(['peer']),
    }).then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    expect(error).toMatchObject({ code: 'INVALID_LOCKFILE' });
    expect(error?.message).toBe(
      'opm ci --omit peer does not apply to a pnpm lock: it writes resolved peers as ordinary dependencies, so there is nothing to omit them by',
    );
  });
});
