/**
 * Locks real pnpm 10.28 installs with `--frozen-lockfile`, which opm ci
 * refused while saying pnpm would refuse them too (the review of #179 ran each
 * against pnpm): a member linked under an alias, an override whose range
 * intersects the dependency's, `parent>name` on a project with no workspace, an
 * importer the project no longer has, and a new member with no dependencies.
 */

import { describe, expect, it } from 'vitest';
import { worldOf, member } from './frozen-support.js';
import { LOCK, dependency, pkg } from './lock-support.js';

/** The message a refusal is, or undefined when the lock is read. */
async function refusal(world: Awaited<ReturnType<typeof worldOf>>) {
  return world.read().then(
    (lock) =>
      lock.refused.length > 0
        ? lock.refused.map((item) => `${item.path} ${item.reason}`).join('; ')
        : undefined,
    (error: Error) => error.message,
  );
}

const WORKSPACE = (rootDependencies: string, extraImporters = '') =>
  LOCK(`importers:

  .:
    dependencies:
${rootDependencies}
  packages/b: {}
${extraImporters}
packages:

${pkg('left-pad@1.3.0')}

snapshots:

  left-pad@1.3.0: {}
`);

describe('what pnpm installs and opm ci now installs too', () => {
  it('links a member under an alias, as many times as it is asked', async () => {
    const world = await worldOf(
      WORKSPACE(
        `${dependency('e', 'workspace:b@*', 'link:packages/b')}${dependency('bb', 'workspace:b@*', 'link:packages/b')}`,
      ),
      {
        manifest: (id, manifest) =>
          id === 'packages/b' ? { ...manifest, name: 'b' } : manifest,
      },
    );
    expect(await refusal(world)).toBeUndefined();
    const lock = await world.read();
    expect(lock.workspace?.layout.links).toEqual([
      { path: 'node_modules/bb', target: '../packages/b' },
      { path: 'node_modules/e', target: '../packages/b' },
    ]);
  });

  it('applies an override whose range intersects the dependency’s, as pnpm does', async () => {
    for (const selector of ['left-pad@^1.0.0', 'left-pad@<2']) {
      const world = await worldOf(
        LOCK(`overrides:
  '${selector}': 1.3.0

importers:

  .:
    dependencies:
${dependency('left-pad', '1.3.0', '1.3.0')}
packages:

${pkg('left-pad@1.3.0')}

snapshots:

  left-pad@1.3.0: {}
`),
        {
          manifest: (id, manifest) =>
            id === '.'
              ? { ...manifest, dependencies: { 'left-pad': '^1.2.0' } }
              : manifest,
        },
      );
      expect(await refusal(world), selector).toBeUndefined();
    }
  });

  it('applies parent>name to a project with no workspace, by its own name', async () => {
    const world = await worldOf(
      LOCK(`overrides:
  app>left-pad: 1.3.0

importers:

  .:
    dependencies:
${dependency('left-pad', '1.3.0', '1.3.0')}
packages:

${pkg('left-pad@1.3.0')}

snapshots:

  left-pad@1.3.0: {}
`),
      {
        manifest: (id, manifest) =>
          id === '.'
            ? {
                ...manifest,
                name: 'app',
                dependencies: { 'left-pad': '^1.0.0' },
              }
            : manifest,
      },
    );
    expect(await refusal(world)).toBeUndefined();
  });

  it('leaves out an importer the project no longer has, and does not touch its directory', async () => {
    const world = await worldOf(
      WORKSPACE(
        dependency('left-pad', '^1.0.0', '1.3.0'),
        `  packages/gone:\n    dependencies:\n${dependency('left-pad', '^1.0.0', '1.3.0')}`,
      ),
      {
        disk: (members) =>
          members.filter((found) => found.dir !== 'packages/gone'),
      },
    );
    expect(await refusal(world)).toBeUndefined();
    const lock = await world.read();
    expect(lock.workspace?.memberDirs).toEqual(['packages/b']);
    expect(lock.packages.map((item) => item.path)).toEqual([
      'node_modules/left-pad',
    ]);
  });

  it('installs a project with a new member that has no dependencies yet', async () => {
    const world = await worldOf(
      WORKSPACE(dependency('left-pad', '^1.0.0', '1.3.0')),
      {
        disk: (members) => [...members, member('packages/new', {}, 'new')],
      },
    );
    expect(await refusal(world)).toBeUndefined();
  });
});

describe('what opm ci still refuses, as its own rule', () => {
  it('refuses a new member that has dependencies the lock does not list', async () => {
    const world = await worldOf(
      WORKSPACE(dependency('left-pad', '^1.0.0', '1.3.0')),
      {
        disk: (members) => [
          ...members,
          member(
            'packages/new',
            { dependencies: { 'left-pad': '^1.0.0' } },
            'new',
          ),
        ],
      },
    );
    const message = await refusal(world);
    expect(message).toMatch(/"packages\/new"/u);
    expect(message).not.toMatch(/pnpm install --frozen-lockfile would refuse/u);
  });

  it('refuses a member that links an importer the project no longer has', async () => {
    const world = await worldOf(
      WORKSPACE(
        dependency('gone', 'workspace:*', 'link:packages/gone'),
        '  packages/gone: {}\n',
      ),
      {
        disk: (members) =>
          members.filter((found) => found.dir !== 'packages/gone'),
      },
    );
    expect(await refusal(world)).toMatch(
      /links "packages\/gone", an importer of the lock that the project no longer has/u,
    );
  });

  it('refuses an override whose range opm does not read as pnpm does, saying so', async () => {
    const world = await worldOf(
      LOCK(`overrides:
  left-pad@v1.x: 1.3.0

importers:

  .:
    dependencies:
${dependency('left-pad', '1.3.0', '1.3.0')}
packages:

${pkg('left-pad@1.3.0')}

snapshots:

  left-pad@1.3.0: {}
`),
      {
        manifest: (id, manifest) =>
          id === '.'
            ? { ...manifest, dependencies: { 'left-pad': '^1.2.0' } }
            : manifest,
      },
    );
    const message = await refusal(world);
    expect(message).toMatch(
      /"left-pad@v1\.x".*opm does not read as pnpm does/u,
    );
    expect(message).not.toMatch(/would refuse too/u);
  });
});
