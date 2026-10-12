import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NativeTarget } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import {
  fixtureBytes,
  type FixtureName,
} from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { buildPnpmModel } from './model.js';
import { selectInstances, type Selection } from './select.js';
import { selectTops } from './scope.js';

interface OracleSelection {
  installed: number;
  platformSkipped: number;
  refused: number;
  orphaned: number;
  packages: number;
  listSha256: string;
}
const ORACLE: Record<string, { selection: Record<string, OracleSelection> }> =
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../fixtures/locks/pnpm-v9/model-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );

const linux = (architecture: string): NativeTarget => ({
  os: 'linux',
  architecture,
  libc: 'glibc',
});

const modelOf = (text: string) => buildPnpmModel(readPnpmLock(text).lock);

describe.each(Object.keys(ORACLE))('selecting from %s', (name) => {
  const model = buildPnpmModel(
    readPnpmLock(fixtureBytes(name as FixtureName)).lock,
  );
  const everything = new Set(model.tops.keys());
  const run = (
    targets: NativeTarget[],
    omit: ('dev' | 'optional')[] = [],
  ): Selection =>
    selectInstances({
      model,
      tops: everything,
      omit: new Set(omit),
      targets,
    });
  const expected = ORACLE[name]!.selection;
  const hash = (selection: Selection) =>
    createHash('sha256')
      .update([...selection.included.keys()].sort().join('\n'))
      .digest('hex');
  const count = (selection: Selection, kind: string) =>
    selection.skipped.filter((skip) => skip.kind === kind).length;

  it.each([
    ['linux-x64', [linux('x64')], []],
    ['linux-x64-omit-dev', [linux('x64')], ['dev']],
    ['linux-x64-and-arm64', [linux('x64'), linux('arm64')], []],
  ] as const)(
    'installs what an independent walk installs on %s',
    (label, targets, omit) => {
      const selection = run([...targets], [...omit]);
      expect(selection.refused).toEqual([]);
      expect(selection.included.size).toBe(expected[label]!.installed);
      expect(count(selection, 'platform')).toBe(
        expected[label]!.platformSkipped,
      );
      expect(count(selection, 'orphaned')).toBe(expected[label]!.orphaned);
      expect(hash(selection)).toBe(expected[label]!.listSha256);
    },
  );

  it('installs every snapshot when every machine is a target', () => {
    const values = (pick: 'os' | 'cpu' | 'libc') => [
      ...new Set(
        [...model.instances.values()]
          .flatMap((i) => i.pkg[pick] ?? [])
          .map((value) => value.replace(/^!/u, ''))
          .filter((value) => value !== 'any' && value !== '*'),
      ),
    ];
    const targets = values('os').flatMap((os) =>
      values('cpu').flatMap((architecture) =>
        [...values('libc'), undefined].map(
          (libc): NativeTarget => ({
            os,
            architecture,
            ...(libc !== undefined && { libc }),
          }),
        ),
      ),
    );
    const selection = run(targets);
    expect(selection.refused).toEqual([]);
    expect(selection.included.size).toBe(expected['everywhere']!.installed);
    expect(hash(selection)).toBe(expected['everywhere']!.listSha256);
  });
});

/** A one-importer lock written for the case, in pnpm's own shape. */
const LOCK = (body: string) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

${body}
`;
const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`;
const pkg = (key: string, extra = '') =>
  `  '${key}':\n    resolution: {integrity: ${INTEGRITY}}\n${extra}`;

describe('what a machine leaves out, and why', () => {
  const lock = LOCK(`importers:

  .:
    dependencies:
      app:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      tool:
        specifier: ^1.0.0
        version: 1.0.0
    optionalDependencies:
      native-arm:
        specifier: ^1.0.0
        version: 1.0.0
      native-x64:
        specifier: ^1.0.0
        version: 1.0.0

packages:

${pkg('app@1.0.0')}
${pkg('tool@1.0.0')}
${pkg('dev-only@1.0.0')}
${pkg('native-arm@1.0.0', '    cpu: [arm64]\n    os: [linux]\n')}
${pkg('native-x64@1.0.0', '    cpu: [x64]\n    os: [linux]\n')}
${pkg('arm-helper@1.0.0')}
${pkg('wrapper@1.0.0')}

snapshots:

  app@1.0.0:
    dependencies:
      wrapper: 1.0.0
  tool@1.0.0:
    dependencies:
      dev-only: 1.0.0
  dev-only@1.0.0: {}
  native-arm@1.0.0:
    dependencies:
      arm-helper: 1.0.0
    optional: true
  native-x64@1.0.0:
    optional: true
  arm-helper@1.0.0:
    optional: true
  wrapper@1.0.0:
    optionalDependencies:
      native-arm: 1.0.0
`);
  const model = modelOf(lock);
  const select = (omit: ('dev' | 'optional')[] = []) =>
    selectInstances({
      model,
      tops: selectTops(model),
      omit: new Set(omit),
      targets: [linux('x64')],
    });

  it('leaves an optional package for another platform out, and what only it brings in', () => {
    const selection = select();
    expect([...selection.included.keys()].sort()).toEqual([
      'app@1.0.0',
      'dev-only@1.0.0',
      'native-x64@1.0.0',
      'tool@1.0.0',
      'wrapper@1.0.0',
    ]);
    expect(
      selection.skipped.map((skip) => [skip.name, skip.kind]).sort(),
    ).toEqual([
      ['arm-helper', 'orphaned'],
      ['native-arm', 'platform'],
    ]);
    expect(selection.refused).toEqual([]);
  });

  it('reads each package by how it is reached: runtime, development or optional', () => {
    const scopes = Object.fromEntries(select().included);
    expect(scopes).toEqual({
      'app@1.0.0': 'runtime',
      'wrapper@1.0.0': 'runtime',
      'tool@1.0.0': 'development',
      'dev-only@1.0.0': 'development',
      'native-x64@1.0.0': 'optional',
    });
  });

  it('leaves the development dependencies and what only they reach out with --omit dev', () => {
    const selection = select(['dev']);
    expect([...selection.included.keys()]).not.toContain('tool@1.0.0');
    expect([...selection.included.keys()]).not.toContain('dev-only@1.0.0');
    expect(
      selection.skipped
        .filter((skip) => skip.kind === 'omitted')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['dev-only', 'tool']);
  });

  it('leaves every optional edge out with --omit optional, in the importers and in packages', () => {
    const selection = select(['optional']);
    expect([...selection.included.keys()].sort()).toEqual([
      'app@1.0.0',
      'dev-only@1.0.0',
      'tool@1.0.0',
      'wrapper@1.0.0',
    ]);
  });

  it('refuses, by name, a package that does not run here and is not optional', () => {
    const other = modelOf(
      LOCK(`importers:

  .:
    dependencies:
      native-arm:
        specifier: ^1.0.0
        version: 1.0.0

packages:

${pkg('native-arm@1.0.0', '    cpu: [arm64]\n')}

snapshots:

  native-arm@1.0.0: {}
`),
    );
    const selection = selectInstances({
      model: other,
      tops: selectTops(other),
      omit: new Set(),
      targets: [linux('x64')],
    });
    expect(selection.refused).toEqual([
      {
        path: 'native-arm@1.0.0',
        reason:
          'native-arm@1.0.0 is for cpu arm64, not linux/x64/glibc, and is not optional',
      },
    ]);
  });
});

describe('which importers are installed', () => {
  const model = buildPnpmModel(
    readPnpmLock(fixtureBytes('ai-bdd.pnpm-lock.yaml')).lock,
  );

  it('is every importer with no selection, the project alone for --workspaces=false', () => {
    expect(selectTops(model).size).toBe(9);
    expect([...selectTops(model, { kind: 'root' })]).toEqual(['.']);
  });

  it('adds the members a selected one links, and theirs, and not the project', () => {
    const chosen = selectTops(model, {
      kind: 'members',
      dirs: ['packages/cli'],
      includeRoot: false,
    });
    expect([...chosen].sort()).toEqual([
      'packages/cli',
      'packages/driver-playwright',
      'packages/models-ai-sdk',
      'packages/sdk',
    ]);
  });

  it("does not follow the project's own links when it is installed alongside a selection", () => {
    const chosen = selectTops(model, {
      kind: 'members',
      dirs: ['packages/testing'],
      includeRoot: true,
    });
    expect([...chosen].sort()).toEqual([
      '.',
      'packages/sdk',
      'packages/testing',
    ]);
  });

  it('names a selection that is not an importer of the lock', () => {
    expect(() =>
      selectTops(model, {
        kind: 'members',
        dirs: ['packages/nope'],
        includeRoot: false,
      }),
    ).toThrow(/packages\/nope, which is not an importer of the lock/u);
  });

  it('reports what a selection leaves out as outside the importers selected', () => {
    const tops = selectTops(model, {
      kind: 'members',
      dirs: ['packages/testing'],
      includeRoot: false,
    });
    const selection = selectInstances({
      model,
      tops,
      omit: new Set(),
      targets: [linux('x64')],
    });
    expect(selection.included.size).toBeLessThan(model.instances.size / 4);
    expect(selection.skipped.some((skip) => skip.kind === 'workspace')).toBe(
      true,
    );
  });
});
