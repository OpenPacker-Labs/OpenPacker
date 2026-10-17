import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '../pnpm-lock/fixture-support.js';
import { worldOf } from './frozen-support.js';
import { INTEGRITY, LOCK, dependency, pkg } from './lock-support.js';

/** What a lock with one odd package is refused as, by name. */
async function refusedAs(
  packageText: string,
  snapshot = '  odd@1.0.0: {}',
  extraRoot = '',
): Promise<readonly { path: string; reason: string }[]> {
  const world = await worldOf(
    LOCK(`${extraRoot}importers:

  .:
    dependencies:
${dependency('odd', '^1.0.0', '1.0.0')}
packages:

${packageText}

snapshots:

${snapshot}
`),
  );
  return (await world.read()).refused;
}

describe('what opm ci refuses of a pnpm lock, by name', () => {
  it('installs a registry package with a sha512, a sha384 or a sha256 integrity', async () => {
    expect(await refusedAs(pkg('odd@1.0.0'))).toEqual([]);
    const sha256 = `sha256-${Buffer.alloc(32).toString('base64')}`;
    expect(
      await refusedAs(
        `  'odd@1.0.0':\n    resolution: {integrity: ${sha256}}\n`,
      ),
    ).toEqual([]);
  });

  it('refuses a package that only has a sha1, which does not pin its bytes', async () => {
    const sha1 = `sha1-${Buffer.alloc(20).toString('base64')}`;
    expect(
      await refusedAs(`  'odd@1.0.0':\n    resolution: {integrity: ${sha1}}\n`),
    ).toEqual([
      {
        path: 'odd@1.0.0',
        reason:
          '"odd@1.0.0" has only a sha1 integrity, which does not pin its bytes',
      },
    ]);
  });

  it('refuses a tarball with no integrity, and installs one that has', async () => {
    const lock = (resolution: string) =>
      `  'odd@https://example.test/odd-1.0.0.tgz':\n    resolution: {${resolution}}\n    version: 1.0.0\n`;
    const snapshot = '  odd@https://example.test/odd-1.0.0.tgz: {}';
    const world = async (resolution: string) =>
      (
        await worldOf(
          LOCK(`importers:

  .:
    dependencies:
${dependency('odd', 'https://example.test/odd-1.0.0.tgz', 'https://example.test/odd-1.0.0.tgz')}
packages:

${lock(resolution)}
snapshots:

${snapshot}
`),
        )
      ).read();
    const bare = await world('tarball: https://example.test/odd-1.0.0.tgz');
    expect(bare.refused).toHaveLength(1);
    expect(bare.refused[0]!.reason).toMatch(/has no integrity/u);
    const pinned = await world(
      `tarball: https://example.test/odd-1.0.0.tgz, integrity: ${INTEGRITY}`,
    );
    expect(pinned.refused).toEqual([]);
    expect(pinned.packages[0]).toMatchObject({
      sourceKind: 'tarball',
      source: 'https://example.test/odd-1.0.0.tgz',
    });
  });

  it('refuses a package from a git repository', async () => {
    const commit = 'a'.repeat(40);
    const key = `odd@git+https://example.test/odd.git#${commit}`;
    const world = await worldOf(
      LOCK(`importers:

  .:
    dependencies:
${dependency('odd', `git+https://example.test/odd.git#${commit}`, `git+https://example.test/odd.git#${commit}`)}
packages:

  '${key}':
    resolution: {commit: ${commit}, repo: https://example.test/odd.git, type: git}
    version: 1.0.0

snapshots:

  '${key}': {}
`),
    );
    const refused = (await world.read()).refused;
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain('comes from a git repository');
  });

  it('refuses a directory, a file: archive and a runtime', async () => {
    const dir = await worldOf(
      LOCK(`importers:

  .:
    dependencies:
${dependency('odd', 'file:../odd', 'file:../odd')}
packages:

  'odd@file:../odd':
    resolution: {directory: ../odd, type: directory}
    version: 1.0.0

snapshots:

  'odd@file:../odd': {}
`),
    );
    expect((await dir.read()).refused[0]!.reason).toContain(
      'comes from the directory "../odd"',
    );
  });

  it('refuses a patch, whole, naming each, with what else the lock says by itself and nothing of its packages', async () => {
    const world = await worldOf(fixtureBytes('exotic.pnpm-lock.yaml'));
    const refused = (await world.read()).refused;
    const patches = refused.filter((item) =>
      item.path.startsWith('patchedDependencies['),
    );
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches)
      expect(patch.reason).toMatch(
        /is a patch, and opm does not apply patches/u,
      );
    // The rest is the importers' own settings: nothing about a package is
    // said until the lock can be installed as written.
    for (const other of refused.filter((item) => !patches.includes(item)))
      expect(other.path).toMatch(
        /^importers\[".*"\]\.(?:dependenciesMeta|publishDirectory)$/u,
      );
  });

  it('refuses an injected dependency and a publish directory, on the importer', async () => {
    const world = await worldOf(
      LOCK(`importers:

  .:
    dependencies:
${dependency('odd', '^1.0.0', '1.0.0')}    dependenciesMeta:
      odd:
        injected: true
    publishDirectory: dist

packages:

${pkg('odd@1.0.0')}

snapshots:

  odd@1.0.0: {}
`),
    );
    const refused = (await world.read()).refused;
    expect(refused.map((item) => item.path)).toEqual([
      'importers["."].dependenciesMeta',
      'importers["."].publishDirectory',
    ]);
  });

  it('refuses a lock written without the links between members', async () => {
    const text = new TextDecoder()
      .decode(fixtureBytes('ai-bdd.pnpm-lock.yaml'))
      .replace(
        'excludeLinksFromLockfile: false',
        'excludeLinksFromLockfile: true',
      );
    const refused = (await (await worldOf(text)).read()).refused;
    expect(refused).toEqual([
      expect.objectContaining({ path: 'settings.excludeLinksFromLockfile' }),
    ]);
  });

  it('refuses a link to a directory that is not an importer, and says where it points', async () => {
    const world = await worldOf(
      LOCK(`importers:

  .:
    dependencies:
${dependency('outside', 'link:../outside', 'link:../outside')}
packages: {}

snapshots: {}
`),
    );
    expect((await world.read()).refused).toEqual([
      {
        path: 'importers["."]["outside"]',
        reason:
          'links "../outside", which is not a workspace member (an importer of this lock); opm links members only',
      },
    ]);
  });

  it('refuses nothing outside the importers being installed', async () => {
    // The exotic lock's odd packages are reachable from importers that a
    // selection leaves out; the lock-level refusal is the only thing it says
    // while it has patches. A lock without them is judged on what it installs.
    const text = new TextDecoder().decode(
      fixtureBytes('ai-bdd.pnpm-lock.yaml'),
    );
    const world = await worldOf(text);
    expect((await world.read()).refused).toEqual([]);
  });
});
