import type { PolicyInput } from '@openpacker/contracts';
import type { OpmManifest } from '../src/index.js';
import type { FixturePackage } from './npm-registry-fixture.js';

/**
 * Registries of the shapes a resolve meets, for the tests that must find the
 * same lock however the resolve is run: a diamond, a platform package with one
 * optional dependency per platform, dev-time specifiers the walk must not
 * follow, a heavy packument, and graphs drawn from a seed.
 */

export interface Scenario {
  readonly name: string;
  readonly packages: readonly FixturePackage[];
  /** The packages the project asks for, by name. */
  readonly roots: readonly string[];
}

export const permissive: PolicyInput = {
  allowYanked: false,
  allowQuarantined: false,
  semanticLossMaximum: 'warning',
  requiredEvidence: [],
};

export function manifestFor(roots: readonly string[]): OpmManifest {
  return {
    project: { name: 'scenario', ecosystems: ['npm'] },
    packages: Object.fromEntries(
      roots.map((name) => [
        name,
        { alias: name, purl: `pkg:npm/${name}`, version: '1.0.0' },
      ]),
    ),
    options: { offline: false, layout: 'opm' },
    policy: permissive,
  };
}

const native = (suffix: string, os: string, cpu: string, libc?: string) => ({
  name: `native-${suffix}`,
  versions: {
    '1.0.0': { os: [os], cpu: [cpu], ...(libc && { libc: [libc] }) },
  },
});

const diamond: Scenario = {
  name: 'a diamond: one package reached from two places',
  roots: ['app'],
  packages: [
    {
      name: 'app',
      versions: { '1.0.0': { dependencies: { left: '^1', right: '^1' } } },
    },
    {
      name: 'left',
      versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } },
    },
    {
      name: 'right',
      versions: { '1.0.0': { dependencies: { shared: '>=1.2.0 <2' } } },
    },
    { name: 'shared', versions: { '1.0.0': {}, '1.2.0': {}, '1.3.0': {} } },
  ],
};

const platforms: Scenario = {
  name: 'one optional dependency per platform',
  roots: ['native'],
  packages: [
    {
      name: 'native',
      versions: {
        '1.0.0': {
          optionalDependencies: {
            'native-linux-x64-gnu': '1.0.0',
            'native-linux-x64-musl': '1.0.0',
            'native-linux-arm64-gnu': '1.0.0',
            'native-darwin-arm64': '1.0.0',
          },
        },
      },
    },
    native('linux-x64-gnu', 'linux', 'x64', 'glibc'),
    native('linux-x64-musl', 'linux', 'x64', 'musl'),
    native('linux-arm64-gnu', 'linux', 'arm64', 'glibc'),
    native('darwin-arm64', 'darwin', 'arm64'),
  ],
};

const devTime: Scenario = {
  name: 'dev-time specifiers the walk must not follow',
  roots: ['tool'],
  packages: [
    {
      name: 'tool',
      versions: {
        '1.0.0': {
          dependencies: { fmt: '^2.0.0' },
          devDependencies: {
            'react-is': 'npm:react-is@18.3.1',
            'time-require': 'github:jonschlinkert/time-require',
            latest: 'latest',
          },
        },
      },
    },
    { name: 'fmt', versions: { '2.0.0': {}, '2.1.0': {} } },
  ],
};

const heavy: Scenario = {
  name: 'a heavy packument beside light ones',
  roots: ['heavy'],
  packages: [
    {
      name: 'heavy',
      versions: {
        '1.0.0': { dependencies: { light: '^1.0.0', other: '^1.0.0' } },
      },
      padding: { bytes: 1_500_000, values: 20_000 },
    },
    {
      name: 'light',
      versions: { '1.0.0': { dependencies: { other: '^1.0.0' } } },
    },
    {
      name: 'other',
      versions: { '1.0.0': {}, '1.1.0': {} },
      padding: { bytes: 700_000 },
    },
  ],
};

/** A small, fast generator: the same seed is the same graph on every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A graph of `count` packages drawn from `seed`. A package depends only on
 * packages after it, so the graph has no cycle. Every third package is padded
 * so that the whole is a few megabytes.
 */
export function randomGraph(seed: number, count = 36): Scenario {
  const next = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)]!;
  const versionsOf = (index: number) => 1 + ((index * 7 + seed) % 4);
  const packages: FixturePackage[] = [];
  for (let index = 0; index < count; index += 1) {
    const versions: FixturePackage['versions'] = {};
    for (let version = 0; version < versionsOf(index); version += 1) {
      const dependencies: Record<string, string> = {};
      const fanout = Math.floor(next() * 4);
      for (let edge = 0; edge < fanout && index + 1 < count; edge += 1) {
        const target =
          index + 1 + Math.floor(next() * Math.min(count - index - 1, 8));
        // Every range takes every version, so no draw is a conflict the
        // solver would have to refuse; which version is chosen still depends
        // on what each version asks for.
        dependencies[`p${target}`] = pick(['*', '^1.0.0', '>=1.0.0 <2', '1.x']);
      }
      versions[`1.${version}.0`] = { dependencies };
    }
    packages.push({
      name: `p${index}`,
      versions,
      ...(index % 3 === 0 && {
        padding: { bytes: 120_000 + Math.floor(next() * 200_000) },
      }),
    });
  }
  const roots = [
    'p0',
    `p${1 + Math.floor(next() * 3)}`,
    `p${4 + Math.floor(next() * 3)}`,
  ];
  return { name: `a random graph, seed ${seed}`, packages, roots };
}

export const SCENARIOS: readonly Scenario[] = [
  diamond,
  platforms,
  devTime,
  heavy,
  randomGraph(1),
  randomGraph(20261012),
  randomGraph(7, 60),
];
