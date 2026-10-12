import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PackageInstance } from '@openpacker/contracts';
import { codecFor, resolveGraph, solveGraph } from '../src/index.js';
import { installedRequirements } from '../src/closure-edges.js';
import {
  nativeRange,
  requirementInstallName,
  satisfiesNative,
} from '../src/requirement-info.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * Random registries with aliases and several versions of one name.
 *
 * Whatever the registry is, a closure the solver returns must satisfy every
 * edge by the ecosystem's own range rules, must be the same closure the next
 * time and whatever order the registry lists things in, must hold a name at
 * several versions only where no single release suits every dependent, and
 * must be refused only when no closure exists (checked by trying every subset
 * of what the walk found).
 */

// A soak run: OPM_PROPERTY_RUNS=1000 OPM_PROPERTY_SEED=7 npx vitest run test/closure-properties.test.ts
const RUNS = Number(process.env.OPM_PROPERTY_RUNS ?? 120);
const SEED = Number(process.env.OPM_PROPERTY_SEED ?? 20261012);

const VERSIONS = ['1.0.0', '1.5.0', '2.0.0', '3.0.0'] as const;
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
] as const;
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

/** Whether any set of the packages the walk found holds a closed closure. */
function someClosureExists(packages: readonly PackageInstance[]): boolean {
  const roots = packages.filter(
    (item) => item.identity.canonicalPurl === 'pkg:npm/root',
  );
  const count = packages.length;
  for (let mask = 1; mask < 2 ** count; mask += 1) {
    const chosen = packages.filter((_item, index) => (mask >> index) & 1);
    if (!chosen.some((item) => roots.includes(item))) continue;
    const closed = chosen.every((item) =>
      installedRequirements(item).every((requirement) => {
        const base =
          requirement.expression.type === 'package'
            ? requirement.expression.purl
            : '';
        const range = nativeRange(requirement);
        return chosen.some(
          (candidate) =>
            candidate.identity.canonicalPurl === base &&
            (range === undefined ||
              satisfiesNative('npm', candidate.nativeVersion, range)),
        );
      }),
    );
    if (closed) return true;
  }
  return false;
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
            expect(someClosureExists(first.graph.packages)).toBe(false);
          return;
        }
        solvedCount += 1;
        const { solved, graph } = first;
        const selected = solved.selected;
        const byNode = new Map(selected.map((item) => [item.nodeId, item]));

        // Every installed requirement of every selected package has exactly one
        // edge, to a selected package of that name whose version it accepts,
        // under the name the requirement was written with.
        for (const item of selected)
          for (const requirement of installedRequirements(item)) {
            const edges = solved.dependencyEdges.filter(
              (edge) =>
                edge.fromNodeId === item.nodeId &&
                edge.requirementId === requirement.id,
            );
            expect(edges, `${exactOf(item)} ${requirement.id}`).toHaveLength(1);
            const target = byNode.get(edges[0]!.toNodeId);
            expect(target).toBeDefined();
            const range = nativeRange(requirement);
            expect(target!.identity.canonicalPurl).toBe(
              requirement.expression.type === 'package'
                ? requirement.expression.purl
                : '',
            );
            if (range !== undefined)
              expect(
                satisfiesNative('npm', target!.nativeVersion, range),
                `${exactOf(item)} needs ${range}, got ${exactOf(target!)}`,
              ).toBe(true);
            expect(edges[0]!.installName).toBe(
              requirementInstallName(requirement),
            );
            if (requirement.nativeSemantics?.data !== undefined)
              aliasEdges += Number(edges[0]!.installName.startsWith('as-'));
          }
        // Nothing is selected that no edge and no root reaches.
        const reached = new Set(
          solved.dependencyEdges.map((edge) => edge.toNodeId),
        );
        for (const item of selected)
          if (item.identity.canonicalPurl !== 'pkg:npm/root')
            expect(reached.has(item.nodeId), exactOf(item)).toBe(true);

        // A name at several versions is a name no single release suits.
        const byName = new Map<string, PackageInstance[]>();
        for (const item of selected)
          byName.set(item.identity.canonicalPurl, [
            ...(byName.get(item.identity.canonicalPurl) ?? []),
            item,
          ]);
        for (const [name, versions] of byName) {
          if (versions.length < 2) continue;
          multi += 1;
          const ranges = solved.dependencyEdges
            .filter(
              (edge) =>
                byNode.get(edge.toNodeId)?.identity.canonicalPurl === name,
            )
            .map((edge) => {
              const from = byNode.get(edge.fromNodeId)!;
              return nativeRange(
                installedRequirements(from).find(
                  (requirement) => requirement.id === edge.requirementId,
                )!,
              );
            })
            .filter((range): range is string => range !== undefined);
          const codec = codecFor('npm');
          void codec;
          const suits = graph.packages.filter(
            (candidate) =>
              candidate.identity.canonicalPurl === name &&
              ranges.every((range) =>
                satisfiesNative('npm', candidate.nativeVersion, range),
              ),
          );
          expect(suits, `${name} could have been one release`).toEqual([]);
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
