import { describe, expect, it } from 'vitest';
import { codecFor } from '../src/codecs.js';
import { solveToolClosure } from '../src/ephemeral-closure.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * `opmx pkg:npm/cowsay@1.5.0`: the release asked for is not the newest, and the
 * two want different majors of a dependency (cowsay 1.5.0 wants
 * `string-width@~2.1.1`, 1.6.0 wants `^4.2.3`). The closure was solved from the
 * tool's name alone, so the solver chose the newest release: the pinned tool
 * had no edges, the newest came along as a "dependency", and the layout gave
 * the tool the dependency version its own range refuses.
 */

const registry: FixturePackage[] = [
  {
    name: 'say',
    versions: {
      '1.5.0': { dependencies: { width: '~2.1.1' } },
      '1.6.0': { dependencies: { width: '^4.2.3' } },
    },
  },
  { name: 'width', versions: { '2.1.1': {}, '4.2.3': {} } },
];

/** The range `say@version` declares for each dependency, from the fixture. */
const declared = (version: string) =>
  registry[0]!.versions[version]!.dependencies!;

describe.each([
  ['1.5.0', 'pkg:npm/width@2.1.1'],
  ['1.6.0', 'pkg:npm/width@4.2.3'],
])('the closure of say@%s', (version, width) => {
  it('is that release, its own edges, and what they require', async () => {
    const tool = `pkg:npm/say@${version}`;
    const closure = await solveToolClosure({
      tool,
      ecosystem: 'npm',
      options: { transport: new NpmRegistryFixture(registry) },
    });
    expect(closure?.dependencies.map((pkg) => pkg.exactPurl)).toEqual([width]);
    const requires = closure?.requires.get(tool);
    expect(requires).toEqual({ width });
    // Every edge the tool has lands on a version its own range admits.
    for (const [name, target] of Object.entries(requires ?? {}))
      expect(
        codecFor('npm').satisfies(
          target.slice(target.lastIndexOf('@') + 1),
          declared(version)[name]!,
        ),
      ).toBe(true);
  });
});

describe('a tool pinned to a release older than the newest six', () => {
  it('is found, though the walk takes only the newest six of a name', async () => {
    const versions = Object.fromEntries(
      Array.from({ length: 8 }, (_, minor) => [
        `1.${minor}.0`,
        { dependencies: { width: minor === 0 ? '~2.1.1' : '^4.2.3' } },
      ]),
    );
    const closure = await solveToolClosure({
      tool: 'pkg:npm/say@1.0.0',
      ecosystem: 'npm',
      options: {
        transport: new NpmRegistryFixture([
          { name: 'say', versions },
          registry[1]!,
        ]),
      },
    });
    expect(closure?.requires.get('pkg:npm/say@1.0.0')).toEqual({
      width: 'pkg:npm/width@2.1.1',
    });
  });
});
