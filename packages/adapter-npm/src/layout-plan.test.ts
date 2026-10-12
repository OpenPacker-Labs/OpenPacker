import { describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import {
  LayoutTooLargeError,
  planLayout,
  toLayoutEntries,
  unsafeNameProblem,
  type LayoutPlan,
} from './layout-plan.js';

interface Spec {
  alias?: string;
  direct?: boolean;
  requires?: string[];
}

/** `name@version` → a lock entry, with `requires` as the aliases it needs. */
function entry(id: string, spec: Spec = {}): NativeLockEntry {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  return {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: `https://registry.example/${name}-${version}.tgz`,
    digest: `sha256:${id.replace(/\W/gu, '').padEnd(64, '0')}`,
    size: 1,
    transitive: spec.direct !== true,
    alias: spec.alias ?? id,
    ...(spec.requires !== undefined && { dependencies: spec.requires }),
  };
}

function plan(...entries: NativeLockEntry[]): LayoutPlan {
  return planLayout(toLayoutEntries(entries));
}

/** `root/b/c` style description of where things landed, for readable asserts. */
function where(result: LayoutPlan): string[] {
  return result.placements
    .map((place) => `${place.chain.join('>')}=${place.entry.version}`)
    .sort();
}

/**
 * Resolve `name` the way Node does from the package at `chain`: its own
 * node_modules first, then each ancestor's, up to the project root.
 */
function nodeResolve(
  result: LayoutPlan,
  chain: readonly string[],
  name: string,
): string | undefined {
  const at = new Map(
    result.placements.map((place) => [place.chain.join('>'), place.entry.id]),
  );
  for (let depth = chain.length; depth >= 0; depth -= 1) {
    const hit = at.get([...chain.slice(0, depth), name].join('>'));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every recorded edge must resolve to the exact entry the solve selected. */
function expectEveryEdgeResolves(
  entries: readonly NativeLockEntry[],
  result: LayoutPlan,
): void {
  const byId = new Map(entries.map((item) => [item.alias, item]));
  for (const place of result.placements) {
    for (const id of place.entry.dependencies) {
      const wanted = byId.get(id)!;
      expect(
        nodeResolve(result, place.chain, wanted.name),
        `${place.chain.join('>')} (${place.entry.id}) needs ${id}`,
      ).toBe(id);
    }
  }
}

describe('planLayout', () => {
  it('lays a closure with no conflicts out flat', () => {
    const entries = [
      entry('app-dep@1.0.0', { direct: true, requires: ['left@1.0.0'] }),
      entry('left@1.0.0', { requires: ['right@1.0.0'] }),
      entry('right@1.0.0'),
    ];
    const result = plan(...entries);
    expect(where(result)).toEqual([
      'app-dep=1.0.0',
      'left=1.0.0',
      'right=1.0.0',
    ]);
    expect(result.skipped).toEqual([]);
    expectEveryEdgeResolves(entries, result);
  });

  it('nests one of two versions of a package that two dependents need', () => {
    // a@1 needs c@1 and b@1 needs c@2: the case a flat layout cannot express.
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['c@1.0.0'] }),
      entry('b@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@1.0.0'),
      entry('c@2.0.0'),
    ];
    const result = plan(...entries);
    // Equally wanted, so the newer one takes the root and the other sits
    // beside the dependent that needs it.
    expect(where(result)).toEqual([
      'a=1.0.0',
      'a>c=1.0.0',
      'b=1.0.0',
      'c=2.0.0',
    ]);
    expect(result.skipped).toEqual([]);
    expectEveryEdgeResolves(entries, result);
  });

  it('gives the root to the version more packages want', () => {
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['c@1.0.0'] }),
      entry('b@1.0.0', { direct: true, requires: ['c@1.0.0'] }),
      entry('d@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@1.0.0'),
      entry('c@2.0.0'),
    ];
    const result = plan(...entries);
    expect(where(result)).toEqual([
      'a=1.0.0',
      'b=1.0.0',
      'c=1.0.0',
      'd=1.0.0',
      'd>c=2.0.0',
    ]);
    expectEveryEdgeResolves(entries, result);
  });

  it('keeps a direct requirement at the root even when fewer packages want it', () => {
    const entries = [
      entry('c@1.0.0', { direct: true }),
      entry('a@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('b@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@2.0.0'),
    ];
    const result = plan(...entries);
    expect(where(result)).toEqual([
      'a=1.0.0',
      'a>c=2.0.0',
      'b=1.0.0',
      'b>c=2.0.0',
      'c=1.0.0',
    ]);
    expectEveryEdgeResolves(entries, result);
  });

  it('checks a nested package against the copy that shadows the root, not the root', () => {
    // b needs c@2 (nested under b because the root holds c@1) and x; x needs
    // c@2 too. x would hoist to the root, where Node finds c@1: it has to be
    // judged from where it really lives.
    const entries = [
      entry('c@1.0.0', { direct: true }),
      entry('b@1.0.0', {
        direct: true,
        requires: ['c@2.0.0', 'x@1.0.0'],
      }),
      entry('x@1.0.0', { requires: ['c@2.0.0'] }),
      entry('c@2.0.0'),
    ];
    const result = plan(...entries);
    expectEveryEdgeResolves(entries, result);
    expect(result.skipped).toEqual([]);
  });

  it('terminates on a dependency cycle', () => {
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['b@1.0.0'] }),
      entry('b@1.0.0', { requires: ['a@1.0.0'] }),
    ];
    const result = plan(...entries);
    expect(where(result)).toEqual(['a=1.0.0', 'b=1.0.0']);
    expectEveryEdgeResolves(entries, result);
  });

  it('places two directs of one name only once and says why the other is left out', () => {
    const result = plan(
      entry('c@1.0.0', { direct: true, alias: 'c1' }),
      entry('c@2.0.0', { direct: true, alias: 'c2' }),
    );
    expect(result.placements).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/required directly/u);
  });

  it('places by name alone when the lock recorded no edges, newest first', () => {
    const result = plan(
      entry('a@1.0.0', { direct: true }),
      entry('c@1.0.0'),
      entry('c@2.0.0'),
      entry('d@1.0.0'),
    );
    expect(where(result)).toEqual(['a=1.0.0', 'c=2.0.0', 'd=1.0.0']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.entry.version).toBe('1.0.0');
    expect(result.skipped[0]!.reason).toMatch(
      /not required by any recorded dependency edge/u,
    );
  });

  it('ignores an edge to a package that is not in the lock', () => {
    const result = plan(
      entry('a@1.0.0', { direct: true, requires: ['ghost@1.0.0'] }),
    );
    expect(where(result)).toEqual(['a=1.0.0']);
  });

  it('refuses a name that is not a safe directory', () => {
    const result = plan(
      entry('.bin@1.0.0', { direct: true }),
      entry('node_modules@1.0.0', { direct: true }),
      entry('@evil/../../x@1.0.0', { direct: true }),
      entry('fine@1.0.0', { direct: true }),
    );
    expect(where(result)).toEqual(['fine=1.0.0']);
    expect(result.skipped).toHaveLength(3);
  });

  it('orders parents before the packages nested in them', () => {
    const result = plan(
      entry('c@1.0.0', { direct: true }),
      entry('b@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@2.0.0'),
    );
    const depths = result.placements.map((place) => place.chain.length);
    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('is deterministic whatever order the entries arrive in', () => {
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['c@1.0.0'] }),
      entry('b@1.0.0', { direct: true, requires: ['c@2.0.0'] }),
      entry('c@1.0.0'),
      entry('c@2.0.0'),
    ];
    const forward = where(plan(...entries));
    const reversed = where(plan(...[...entries].reverse()));
    expect(reversed).toEqual(forward);
  });
});

describe('planLayout limits', () => {
  it('refuses a plan larger than the limit instead of building it', () => {
    const entries = [
      entry('a@1.0.0', { direct: true, requires: ['b@1.0.0', 'c@1.0.0'] }),
      entry('b@1.0.0'),
      entry('c@1.0.0'),
    ];
    expect(() =>
      planLayout(toLayoutEntries(entries), { maximumPlacements: 2 }),
    ).toThrow(LayoutTooLargeError);
    expect(
      planLayout(toLayoutEntries(entries), { maximumPlacements: 3 }).placements,
    ).toHaveLength(3);
  });

  it('bounds a lock built to nest the same conflict under every dependent', () => {
    // n dependents each need their own version of c, so c is placed n times.
    const dependents = Array.from({ length: 40 }, (_, index) =>
      entry(`d${index}@1.0.0`, {
        direct: true,
        requires: [`c@${index + 1}.0.0`],
      }),
    );
    const versions = dependents.map((_, index) => entry(`c@${index + 1}.0.0`));
    expect(() =>
      planLayout(toLayoutEntries([...dependents, ...versions]), {
        maximumPlacements: 50,
      }),
    ).toThrow(/refusing to write a layout that large/u);
  });
});

describe('planLayout over random closures', () => {
  /** Small deterministic generator, so a failure names its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function closure(seed: number): NativeLockEntry[] {
    const next = random(seed);
    const names = Array.from({ length: 7 }, (_, index) => `p${index}`);
    const versions = ['1.0.0', '1.2.0', '2.0.0'];
    const have = new Map<string, string[]>();
    const entries: NativeLockEntry[] = [];
    for (const [index, name] of names.entries()) {
      for (const version of versions) {
        if (next() < 0.4 && !(index === 0 && version === '1.0.0')) continue;
        have.set(name, [...(have.get(name) ?? []), version]);
      }
    }
    for (const [index, name] of names.entries()) {
      for (const version of have.get(name) ?? []) {
        const requires: string[] = [];
        // Only forward edges, so the closure is acyclic like most real ones,
        // and at most one version of a name per dependent.
        for (const later of names.slice(index + 1)) {
          const options = have.get(later) ?? [];
          if (options.length > 0 && next() < 0.45)
            requires.push(
              `${later}@${options[Math.floor(next() * options.length)]!}`,
            );
        }
        entries.push(
          entry(`${name}@${version}`, {
            direct: index < 2 && next() < 0.7,
            requires,
          }),
        );
      }
    }
    // One direct version per name: a manifest cannot ask for two.
    const seen = new Set<string>();
    return entries.map((item) => {
      if (item.transitive || !seen.has(item.name)) {
        if (!item.transitive) seen.add(item.name);
        return item;
      }
      return { ...item, transitive: true };
    });
  }

  it('resolves every edge to the version the solve selected', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const entries = closure(seed);
      const result = plan(...entries);
      const skippedIds = new Set(result.skipped.map((skip) => skip.entry.id));
      const placedIds = new Set(
        result.placements.map((place) => place.entry.id),
      );
      for (const place of result.placements)
        for (const id of place.entry.dependencies) {
          const wanted = entries.find((item) => item.alias === id)!;
          expect(
            nodeResolve(result, place.chain, wanted.name),
            `seed ${seed}: ${place.chain.join('>')} (${place.entry.id}) needs ${id}`,
          ).toBe(id);
        }
      // Nothing that is wanted is dropped: everything a direct requirement
      // reaches is placed, and every other entry is either placed or told why
      // it was left out.
      const reached = new Set<string>();
      const pending = entries.filter((item) => !item.transitive);
      while (pending.length > 0) {
        const item = pending.pop()!;
        if (reached.has(item.alias!)) continue;
        reached.add(item.alias!);
        for (const id of item.dependencies ?? [])
          pending.push(entries.find((other) => other.alias === id)!);
      }
      for (const item of entries) {
        const accounted =
          placedIds.has(item.alias!) || skippedIds.has(item.alias!);
        expect(accounted, `seed ${seed}: ${item.alias}`).toBe(true);
        if (reached.has(item.alias!))
          expect(
            placedIds.has(item.alias!),
            `seed ${seed}: ${item.alias}`,
          ).toBe(true);
      }
    }
  });
});

describe('helpers', () => {
  it.each(['react', '@scope/pkg', 'a.b', 'under_score', 'x~y'])(
    'accepts %s as a directory name',
    (name) => {
      expect(unsafeNameProblem(name)).toBeUndefined();
    },
  );

  it.each([
    '',
    '.bin',
    '..',
    '../x',
    'a/b',
    '@scope',
    '@scope/',
    '@/x',
    'node_modules',
    '@scope/node_modules',
    'NODE_MODULES',
    '@scope/Node_Modules',
    '@NODE_MODULES/x',
    'a\\b',
    'a\0b',
    'x y',
  ])('refuses %j as a directory name', (name) => {
    expect(unsafeNameProblem(name)).toBeDefined();
  });
});
