import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PackageInstance } from '@openpacker/contracts';
import { resolveGraph, solveGraph } from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * Random registries with aliases, prereleases and several versions of one name.
 *
 * Whatever the registry is, a closure the solver returns must satisfy every
 * edge by the ecosystem's own range rules, must be the same closure the next
 * time and whatever order the registry lists things in, must hold a name at
 * several versions only where no single release suits every dependent, and
 * must be refused only when no closure exists (checked by trying every subset
 * of what the walk found).
 *
 * The oracle is not the code under test. Which versions a range accepts is
 * written out below, once, by hand, for each range the generator can draw
 * (node-semver's rules: a prerelease satisfies a range only through a
 * comparator on the same major.minor.patch that has a prerelease), and the
 * edges expected of each release are read from the generated registry itself,
 * not from the requirements the walk produced.
 */

// A soak run: OPM_PROPERTY_RUNS=1000 OPM_PROPERTY_SEED=7 npx vitest run test/closure-properties.test.ts
const RUNS = Number(process.env.OPM_PROPERTY_RUNS ?? 120);
const SEED = Number(process.env.OPM_PROPERTY_SEED ?? 20261012);

const VERSIONS = [
  '1.0.0',
  '1.5.0',
  '2.0.0',
  '2.0.0-rc.1',
  '3.0.0-rc.1',
  '3.0.0',
] as const;
// Mostly ranges several releases satisfy, and a few that few do.
const RANGES = [
  '*',
  '^1',
  '^1',
  '>=1',
  '>=1.0.0 <3.0.0',
  '^2',
  '1.5.0',
  '~1.0.0',
  '^3',
  '>=2.0.0-rc.0',
  '^2.0.0-0',
] as const;

/** What each range accepts of VERSIONS, by node-semver's rules, by hand. */
const ACCEPTS: Record<
  (typeof RANGES)[number],
  readonly (typeof VERSIONS)[number][]
> = {
  '*': ['1.0.0', '1.5.0', '2.0.0', '3.0.0'],
  '^1': ['1.0.0', '1.5.0'],
  '>=1': ['1.0.0', '1.5.0', '2.0.0', '3.0.0'],
  '>=1.0.0 <3.0.0': ['1.0.0', '1.5.0', '2.0.0'],
  '^2': ['2.0.0'],
  '1.5.0': ['1.5.0'],
  '~1.0.0': ['1.0.0'],
  '^3': ['3.0.0'],
  '>=2.0.0-rc.0': ['2.0.0-rc.1', '2.0.0', '3.0.0'],
  '^2.0.0-0': ['2.0.0-rc.1', '2.0.0'],
};
const accepts = (range: (typeof RANGES)[number], version: string): boolean =>
  (ACCEPTS[range] as readonly string[]).includes(version);
const NAMES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

interface Dependency {
  target: number;
  range: (typeof RANGES)[number];
  aliased: boolean;
}

interface Spec {
  /** Per package: its versions, and each version's dependencies. */
  packages: {
    versions: {
      version: (typeof VERSIONS)[number];
      dependencies: Dependency[];
    }[];
  }[];
  rootDependencies: Dependency[];
}

const dependency = fc.record({
  target: fc.integer({ min: 0, max: NAMES.length - 1 }),
  range: fc.constantFrom(...RANGES),
  aliased: fc.boolean(),
});

const spec: fc.Arbitrary<Spec> = fc.record({
  packages: fc.array(
    fc.record({
      versions: fc.uniqueArray(
        fc.record({
          version: fc.constantFrom(...VERSIONS),
          dependencies: fc.uniqueArray(dependency, {
            maxLength: 2,
            selector: (item) => `${item.target}|${item.aliased}`,
          }),
        }),
        { minLength: 2, maxLength: 4, selector: (item) => item.version },
      ),
    }),
    { minLength: NAMES.length, maxLength: NAMES.length },
  ),
  rootDependencies: fc.uniqueArray(dependency, {
    minLength: 1,
    maxLength: 3,
    selector: (item) => `${item.target}|${item.aliased}`,
  }),
});

/** The registry a spec describes, listing its versions in `order`. */
function registryOf(input: Spec, shuffle = false): FixturePackage[] {
  const key = (item: Dependency, index: number) =>
    item.aliased ? `as-${NAMES[item.target]}-${index}` : NAMES[item.target]!;
  const dependencies = (items: Dependency[]) =>
    Object.fromEntries(
      items.map((item, index) => [
        key(item, index),
        item.aliased ? `npm:${NAMES[item.target]}@${item.range}` : item.range,
      ]),
    );
  const packages: FixturePackage[] = input.packages.map((item, index) => ({
    name: NAMES[index]!,
    versions: Object.fromEntries(
      (shuffle ? [...item.versions].reverse() : item.versions).map((entry) => [
        entry.version,
        { dependencies: dependencies(entry.dependencies) },
      ]),
    ),
  }));
  packages.push({
    name: 'root',
    versions: {
      '1.0.0': { dependencies: dependencies(input.rootDependencies) },
    },
  });
  return shuffle ? packages.reverse() : packages;
}

async function solve(registry: FixturePackage[]) {
  const graph = await resolveGraph({
    roots: [{ purl: 'pkg:npm/root' }],
    options: { transport: new NpmRegistryFixture(registry) },
  });
  try {
    const solved = await solveGraph({
      graph,
      rootRequirements: [{ purl: 'pkg:npm/root' }],
    });
    return { graph, solved };
  } catch (error) {
    return { graph, error: error as Error };
  }
}

/** The dependencies the generated registry gives a release. */
function dependenciesOf(
  input: Spec,
  name: string,
  version: string,
): { key: string; target: string; range: (typeof RANGES)[number] }[] {
  const items =
    name === 'root'
      ? input.rootDependencies
      : input.packages[
          NAMES.indexOf(name as (typeof NAMES)[number])
        ]!.versions.find((entry) => entry.version === version)?.dependencies;
  return (items ?? []).map((item, index) => ({
    key: item.aliased
      ? `as-${NAMES[item.target]}-${index}`
      : NAMES[item.target]!,
    target: NAMES[item.target]!,
    range: item.range,
  }));
}

const nameOf = (item: PackageInstance): string =>
  item.identity.canonicalPurl.slice('pkg:npm/'.length);

/**
 * Whether any set of the releases the walk found holds a closed closure: one
 * root, and for every chosen release a chosen release of each dependency's
 * package that the dependency's range accepts.
 */
function someClosureExists(
  input: Spec,
  packages: readonly PackageInstance[],
): boolean {
  const count = packages.length;
  for (let mask = 1; mask < 2 ** count; mask += 1) {
    const chosen = packages.filter((_item, index) => (mask >> index) & 1);
    if (!chosen.some((item) => nameOf(item) === 'root')) continue;
    const closed = chosen.every((item) =>
      dependenciesOf(input, nameOf(item), item.nativeVersion).every(
        (dependency) =>
          chosen.some(
            (candidate) =>
              nameOf(candidate) === dependency.target &&
              accepts(dependency.range, candidate.nativeVersion),
          ),
      ),
    );
    if (closed) return true;
  }
  return false;
}

/**
 * The releases the walk found that can be installed at all: one whose
 * dependency has no installable release is dropped, until none is. Of the
 * releases a name has, only these could have stood in for several.
 */
function installableReleases(
  input: Spec,
  packages: readonly PackageInstance[],
): PackageInstance[] {
  let kept = [...packages];
  for (;;) {
    const next = kept.filter((item) =>
      dependenciesOf(input, nameOf(item), item.nativeVersion).every(
        (dependency) =>
          kept.some(
            (candidate) =>
              nameOf(candidate) === dependency.target &&
              accepts(dependency.range, candidate.nativeVersion),
          ),
      ),
    );
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

const exactOf = (item: PackageInstance) => item.identity.exactPurl!;

describe('a closure over a random registry', () => {
  it('satisfies every edge, is deterministic, splits a name only when it must, and is refused only when none exists', async () => {
    let solvedCount = 0;
    let multi = 0;
    let aliasEdges = 0;
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(spec, async (input) => {
        const registry = registryOf(input);
        const first = await solve(registry);
        const again = await solve(registry);
        const shuffled = await solve(registryOf(input, true));

        if (first.error !== undefined) {
          refused += 1;
          // Refused with a reason, never with a crash.
          expect(first.error).toMatchObject({ code: 'UNRESOLVABLE' });
          expect(first.error.message).toMatch(/requires|satisf/u);
          expect(again.error?.message).toBe(first.error.message);
          // And only because there is nothing to find.
          if (first.graph.packages.length <= 14)
            expect(someClosureExists(input, first.graph.packages)).toBe(false);
          return;
        }
        solvedCount += 1;
        const { solved, graph } = first;
        const selected = solved.selected;
        const byNode = new Map(selected.map((item) => [item.nodeId, item]));

        // Every dependency the registry gives a selected release has exactly one
        // edge, to a selected release of that package the range accepts, under
        // the name the dependency was written with.
        for (const item of selected)
          for (const dependency of dependenciesOf(
            input,
            nameOf(item),
            item.nativeVersion,
          )) {
            const edges = solved.dependencyEdges.filter(
              (edge) =>
                edge.fromNodeId === item.nodeId &&
                edge.installName === dependency.key,
            );
            expect(edges, `${exactOf(item)} ${dependency.key}`).toHaveLength(1);
            const target = byNode.get(edges[0]!.toNodeId);
            expect(target).toBeDefined();
            expect(nameOf(target!)).toBe(dependency.target);
            expect(
              accepts(dependency.range, target!.nativeVersion),
              `${exactOf(item)} needs ${dependency.range}, got ${exactOf(target!)}`,
            ).toBe(true);
            aliasEdges += Number(dependency.key.startsWith('as-'));
          }
        // And no edge the registry did not give.
        for (const edge of solved.dependencyEdges) {
          const from = byNode.get(edge.fromNodeId)!;
          expect(
            dependenciesOf(input, nameOf(from), from.nativeVersion).map(
              (dependency) => dependency.key,
            ),
          ).toContain(edge.installName);
        }
        // Nothing is selected that no edge and no root reaches.
        const reached = new Set(
          solved.dependencyEdges.map((edge) => edge.toNodeId),
        );
        for (const item of selected)
          if (nameOf(item) !== 'root')
            expect(reached.has(item.nodeId), exactOf(item)).toBe(true);

        // A name at several versions is a name no single release suits.
        const byName = new Map<string, PackageInstance[]>();
        for (const item of selected)
          byName.set(nameOf(item), [...(byName.get(nameOf(item)) ?? []), item]);
        for (const [name, versions] of byName) {
          if (versions.length < 2) continue;
          multi += 1;
          const ranges = solved.dependencyEdges
            .filter((edge) => nameOf(byNode.get(edge.toNodeId)!) === name)
            .map((edge) => {
              const from = byNode.get(edge.fromNodeId)!;
              return dependenciesOf(
                input,
                nameOf(from),
                from.nativeVersion,
              ).find((dependency) => dependency.key === edge.installName)!
                .range;
            });
          const suits = installableReleases(input, graph.packages).filter(
            (candidate) =>
              nameOf(candidate) === name &&
              ranges.every((range) => accepts(range, candidate.nativeVersion)),
          );
          expect(
            suits.map(exactOf),
            `${name} could have been one release`,
          ).toEqual([]);
        }

        // The same closure the next time, and whatever order it is listed in.
        expect(again.solved?.selected.map(exactOf)).toEqual(
          selected.map(exactOf),
        );
        expect(again.solved?.dependencyEdges).toEqual(
          solved.dependencyEdges.map((edge) => edge),
        );
        const normal = (value: typeof solved | undefined) =>
          JSON.stringify([
            value?.selected.map(exactOf).sort(),
            value?.dependencyEdges
              .map((edge) => [
                exactOf(
                  value.selected.find(
                    (item) => item.nodeId === edge.fromNodeId,
                  )!,
                ),
                exactOf(
                  value.selected.find((item) => item.nodeId === edge.toNodeId)!,
                ),
                edge.installName,
              ])
              .sort(),
          ]);
        expect(normal(shuffled.solved)).toBe(normal(solved));
      }),
      { numRuns: RUNS, seed: SEED },
    );
    // The property ran over closures that matter, not only trivial ones.
    expect(solvedCount).toBeGreaterThan(RUNS / 4);
    expect(multi).toBeGreaterThan(RUNS / 40);
    expect(aliasEdges).toBeGreaterThan(RUNS / 12);
    expect(refused + solvedCount).toBe(RUNS);
    console.log(
      `closure properties: ${RUNS} registries, ${solvedCount} locked (${multi} names at several versions, ${aliasEdges} alias edges), ${refused} refused`,
    );
  }, 900_000);
});
