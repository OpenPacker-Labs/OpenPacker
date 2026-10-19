/**
 * Settings a frozen install of a pnpm lock does not apply, refused instead of
 * installed as if they were not there (pnpm refuses both: OUTDATED_LOCKFILE for
 * `publishConfig.directory` the lock does not record, LOCKFILE_CONFIG_MISMATCH
 * for `ignoredOptionalDependencies` it does not).
 */

import { describe, expect, it } from 'vitest';
import { worldOf } from './frozen-support.js';
import { LOCK, dependency, pkg } from './lock-support.js';

const lock = (extraRoot = '', member = '') =>
  LOCK(`${extraRoot}importers:

  .:
    dependencies:
${dependency('left-pad', '^1.0.0', '1.3.0')}${member}
packages:

${pkg('left-pad@1.3.0')}

snapshots:

  left-pad@1.3.0: {}
`);

async function outcome(world: Awaited<ReturnType<typeof worldOf>>) {
  return world.read().then(
    (read) => read.refused.map((item) => `${item.path} ${item.reason}`),
    (error: Error) => [error.message],
  );
}

describe('what a frozen pnpm install does not apply, and refuses', () => {
  it('refuses a lock written with ignoredOptionalDependencies', async () => {
    const world = await worldOf(
      lock('ignoredOptionalDependencies:\n  - fsevents\n\n'),
      { root: { pnpm: { ignoredOptionalDependencies: ['fsevents'] } } },
    );
    expect((await outcome(world)).join('\n')).toMatch(
      /ignoredOptionalDependencies .*"fsevents".*opm ci does not install/u,
    );
  });

  it('calls a lock stale when the project ignores optional dependencies it does not', async () => {
    for (const tweaks of [
      { root: { pnpm: { ignoredOptionalDependencies: ['fsevents'] } } },
      { workspaceYaml: 'ignoredOptionalDependencies:\n  - fsevents\n' },
    ]) {
      const world = await worldOf(lock(), tweaks);
      expect((await outcome(world)).join('\n')).toMatch(
        /not up to date with the project.*ignoredOptionalDependencies is \["fsevents"\] in the project and \[\] in pnpm-lock\.yaml/u,
      );
    }
  });

  it('calls a lock stale when an importer publishes from a directory the lock does not record', async () => {
    const single = await worldOf(lock(), {
      root: { publishConfig: { directory: 'dist' } },
    });
    expect((await outcome(single)).join('\n')).toMatch(
      /the project declares publishConfig\.directory "dist" and pnpm-lock\.yaml records no publishDirectory for it/u,
    );
    const workspace = await worldOf(lock('', '  packages/b: {}\n'), {
      manifest: (id, manifest) =>
        id === 'packages/b'
          ? { ...manifest, publishConfig: { directory: 'dist' } }
          : manifest,
    });
    expect((await outcome(workspace)).join('\n')).toMatch(
      /"packages\/b" declares publishConfig\.directory "dist" and pnpm-lock\.yaml records no publishDirectory for it/u,
    );
  });
});
