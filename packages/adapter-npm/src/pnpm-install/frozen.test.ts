import type { FrozenLock, FrozenLockOptions } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import {
  fixtureBytes,
  type FixtureName,
} from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { LINUX, worldOf } from './frozen-support.js';
import { buildPnpmModel } from './model.js';
import { planPlacement } from './place.js';
import { peerSplitProblems, resolutionProblems } from './place-check.js';
import { placeInputOf } from './place-input.js';
import { selectTops } from './scope.js';
import { selectInstances } from './select.js';

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
    // npm and pnpm are this lock's tar readers (ADR 0058 §8).
    expect(lock.extraction).toEqual({
      acceptRedundantEntries: true,
      requireNpmReaderAgreement: true,
    });
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
      expect(pkg.archiveIdentity).toEqual({ version: pkg.version });
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
    const paths = lock.workspace!.layout.links.map((link) => link.path);
    expect(
      paths.filter((path) => path.startsWith('node_modules/')).sort(),
    ).toEqual([...linked].map((link) => `node_modules/${link}`).sort());
    expect(lock.workspace!.memberDirs).toHaveLength(
      [...model.tops.keys()].filter((id) => id !== '.').length,
    );
  });

  it("links each member's workspace dependencies in its own node_modules too, as pnpm does", async () => {
    const lock = await read(name);
    const model = buildPnpmModel(readPnpmLock(fixtureBytes(name)).lock);
    const placed = new Set(lock.packages.map((pkg) => pkg.path));
    const wanted = [...model.tops.values()]
      .filter((top) => top.dir !== '')
      .flatMap((top) =>
        top.edges.flatMap((edge) =>
          edge.kind === 'link' && edge.memberId !== undefined
            ? [`${top.dir}/node_modules/${edge.as}`]
            : [],
        ),
      )
      .filter((path) => !placed.has(path));
    const paths = new Set(
      lock.workspace!.layout.links.map((link) => link.path),
    );
    for (const path of wanted) expect(paths).toContain(path);
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

/**
 * A member's own copy of an instance that Node would find from the member
 * anyway, at an enclosing member's or the project's node_modules: one lock
 * instance at two real paths, so two module instances (ADR 0055 §9).
 */
function redundantCopies(lock: FrozenLock): string[] {
  const members = new Set(lock.workspace?.memberDirs ?? []);
  const at = new Map(lock.packages.map((pkg) => [pkg.path, pkg.instance]));
  const out: string[] = [];
  for (const pkg of lock.packages) {
    const own = /^(.+?)\/node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(pkg.path);
    const [, dir, name] = own ?? [];
    if (dir === undefined || name === undefined || !members.has(dir)) continue;
    const segments = dir.split('/');
    const above = [
      ...segments
        .map((_, index) => segments.slice(0, index).join('/'))
        .filter((outer) => outer !== '' && members.has(outer))
        .reverse(),
      '',
    ];
    for (const outer of above) {
      const holder = at.get(
        outer === '' ? `node_modules/${name}` : `${outer}/node_modules/${name}`,
      );
      if (holder === undefined) continue;
      if (holder === pkg.instance) out.push(`${pkg.path} (${pkg.instance})`);
      break;
    }
  }
  return out;
}

describe.each([
  'ai-bdd.pnpm-lock.yaml',
  'hobo.cut.pnpm-lock.yaml',
  'opensesame.cut.pnpm-lock.yaml',
] as const)('one real path per instance in the plan of %s', (name) => {
  it('writes no instance again in a member that already finds it', async () => {
    const lock = await read(name);
    expect(redundantCopies(lock)).toEqual([]);
  });

  it("places no instance both in a member's own node_modules and anywhere else: no version conflict forces it here", async () => {
    const lock = await read(name);
    const members = new Set(lock.workspace?.memberDirs ?? []);
    const memberSlot = (path: string): boolean => {
      const own = /^(.+?)\/node_modules\/(?:@[^/]+\/)?[^/]+$/u.exec(path);
      return own !== null && members.has(own[1]!);
    };
    const places = new Map<string, string[]>();
    for (const pkg of lock.packages)
      places.set(pkg.instance!, [
        ...(places.get(pkg.instance!) ?? []),
        pkg.path,
      ]);
    expect(
      [...places].filter(
        ([, paths]) => paths.length > 1 && paths.some(memberSlot),
      ),
    ).toEqual([]);
  });

  it("puts every importer's direct dependencies at the top of a node_modules, the member's or the project's", async () => {
    const lock = await read(name);
    const direct = lock.packages.filter((pkg) => pkg.direct);
    expect(direct.length).toBeGreaterThan(0);
    for (const pkg of direct)
      expect(pkg.path.match(/node_modules/gu)).toHaveLength(1);
  });
});

describe.each([
  ['ai-bdd.pnpm-lock.yaml', 354],
  ['hobo.cut.pnpm-lock.yaml', undefined],
  ['opensesame.cut.pnpm-lock.yaml', undefined],
] as const)('peers in the plan of %s', (name, places) => {
  it('loads one copy of every peer a package shares with the package that depends on it', () => {
    const model = buildPnpmModel(readPnpmLock(fixtureBytes(name)).lock);
    const tops = selectTops(model);
    const selection = selectInstances({
      model,
      tops,
      omit: new Set(),
      targets: [LINUX],
    });
    const input = placeInputOf(model, selection, tops);
    const placement = planPlacement(input);
    expect(placement.problems).toEqual([]);
    expect(resolutionProblems(input, placement)).toEqual([]);
    expect(peerSplitProblems(input, placement)).toEqual([]);
    if (places !== undefined) expect(placement.placed).toHaveLength(places);
  });
});
