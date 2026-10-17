import { describe, expect, it } from 'vitest';
import { fixtureBytes } from '../pnpm-lock/fixture-support.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { importerProblems, type ManifestLists } from './fresh.js';
import { worldOf } from './frozen-support.js';
import { LOCK, dependency, pkg } from './lock-support.js';

const AI_BDD = fixtureBytes('ai-bdd.pnpm-lock.yaml');
const HOBO = fixtureBytes('hobo.cut.pnpm-lock.yaml');

/** The refusal a stale lock is: one error, naming what differs. */
async function stale(
  lock: Uint8Array | string,
  tweaks: Parameters<typeof worldOf>[1],
): Promise<string> {
  const world = await worldOf(lock, tweaks);
  const error = await world.read().then(
    () => undefined,
    (thrown: Error) => thrown,
  );
  expect(error).toMatchObject({ code: 'INVALID_LOCKFILE' });
  return error!.message;
}

describe("a lock held to the importers' package.json", () => {
  it('is fresh for the project it was written from', async () => {
    await expect((await worldOf(AI_BDD)).read()).resolves.toMatchObject({
      refused: [],
    });
  });

  it('names the importer, the dependency and both specifiers when one differs', async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) =>
        id === 'packages/sdk'
          ? {
              ...manifest,
              dependencies: {
                ...(manifest['dependencies'] as Record<string, string>),
                zod: '^5.0.0',
              },
            }
          : manifest,
    });
    expect(message).toMatch(
      /pnpm-lock\.yaml is not up to date with the project \(pnpm install --frozen-lockfile would refuse too\)/u,
    );
    expect(message).toMatch(
      /"packages\/sdk": "zod" is "\^5\.0\.0" in package\.json and "[^"]+" in pnpm-lock\.yaml/u,
    );
  });

  it('names a dependency added to package.json since the lock was written', async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) =>
        id === 'packages/testing'
          ? { ...manifest, devDependencies: { left: '^1.0.0' } }
          : manifest,
    });
    expect(message).toContain(
      '"packages/testing": "left" is in package.json (devDependencies) and not in pnpm-lock.yaml',
    );
  });

  it('names a dependency the lock has and package.json dropped', async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) => {
        if (id !== '.') return manifest;
        const dev = {
          ...(manifest['devDependencies'] as Record<string, string>),
        };
        delete dev['fast-check'];
        return { ...manifest, devDependencies: dev };
      },
    });
    expect(message).toContain(
      'the project: "fast-check" is in pnpm-lock.yaml and not in package.json',
    );
  });

  it('names a dependency that moved between lists', async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) => {
        if (id !== '.') return manifest;
        const dev = {
          ...(manifest['devDependencies'] as Record<string, string>),
        };
        const moved = dev['fast-check']!;
        delete dev['fast-check'];
        return {
          ...manifest,
          devDependencies: dev,
          dependencies: { 'fast-check': moved },
        };
      },
    });
    expect(message).toContain(
      'the project: "fast-check" is in dependencies of package.json and in devDependencies of pnpm-lock.yaml',
    );
  });

  it('says them all, up to twenty, and how many more', async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) =>
        id === '.'
          ? {
              ...manifest,
              devDependencies: Object.fromEntries(
                Object.keys(manifest['devDependencies'] as object).map(
                  (name) => [name, '^99.0.0'],
                ),
              ),
            }
          : manifest,
    });
    expect(message.match(/ in package\.json and /gu)).toHaveLength(16);
  });

  it("judges a member's link by the member's own name", async () => {
    const message = await stale(AI_BDD, {
      manifest: (id, manifest) =>
        id === 'packages/sdk' ? { ...manifest, name: 'not-sdk' } : manifest,
    });
    expect(message).toContain(
      '"packages/cli" links "packages/sdk" as "@ai-bdd/sdk", and the member there is called "not-sdk": opm links a member under its own name only',
    );
  });
});

describe('importerProblems', () => {
  const lists = (
    over: Partial<Record<keyof ManifestLists, [string, string][]>>,
  ) =>
    ({
      dependencies: new Map(over.dependencies),
      devDependencies: new Map(over.devDependencies),
      optionalDependencies: new Map(over.optionalDependencies),
      peerDependencies: new Map(over.peerDependencies),
    }) satisfies ManifestLists;
  const importer = (extra: string) =>
    readPnpmLock(
      LOCK(`importers:

  .:
${extra}
packages:

${pkg('react@18.2.0')}
${pkg('left@1.0.0')}

snapshots:

  react@18.2.0: {}
  left@1.0.0: {}
`),
    ).lock.importers[0]!;

  it('puts a peer nobody lists among the dependencies when peers are installed, as pnpm does', () => {
    const lock = importer(
      `    dependencies:\n${dependency('react', '^18.0.0', '18.2.0')}`,
    );
    const manifest = lists({ peerDependencies: [['react', '^18.0.0']] });
    expect(importerProblems('.', manifest, lock, true)).toEqual([]);
    expect(importerProblems('.', manifest, lock, false)).toEqual([
      'the project: "react" is in pnpm-lock.yaml and not in package.json',
    ]);
  });

  it('lets a dependency list win over the same name as a peer', () => {
    const lock = importer(
      `    devDependencies:\n${dependency('react', '^18.2.0', '18.2.0')}`,
    );
    const manifest = lists({
      peerDependencies: [['react', '^18.0.0']],
      devDependencies: [['react', '^18.2.0']],
    });
    expect(importerProblems('.', manifest, lock, true)).toEqual([]);
  });

  it('puts a name in dependencies and devDependencies in dependencies, and one in optionalDependencies there', () => {
    const lock = importer(
      `    dependencies:\n${dependency('left', '^1.0.0', '1.0.0')}    optionalDependencies:\n${dependency('react', '^18.0.0', '18.2.0')}`,
    );
    expect(
      importerProblems(
        '.',
        lists({
          dependencies: [
            ['left', '^1.0.0'],
            ['react', '^18.0.0'],
          ],
          devDependencies: [['left', '^1.0.0']],
          optionalDependencies: [['react', '^18.0.0']],
        }),
        lock,
        true,
      ),
    ).toEqual([]);
  });
});

describe('a lock held to overrides, catalogs and patches', () => {
  it('is stale when the project overrides what the lock does not', async () => {
    const message = await stale(AI_BDD, {
      root: { pnpm: { overrides: { semver: '7.7.2' } } },
    });
    expect(message).toContain(
      'the override "semver" ("7.7.2") is in the project and not in pnpm-lock.yaml',
    );
  });

  it('is stale when the lock overrides what the project does not', async () => {
    const message = await stale(HOBO, { root: { pnpm: {} } });
    expect(message).toContain(
      'the override "ts-autocode-grounding" is in pnpm-lock.yaml and not in the project',
    );
  });

  it('is stale when an override says another thing', async () => {
    const message = await stale(HOBO, {
      root: {
        pnpm: {
          overrides: {
            'ts-autocode-grounding': '0.1.0',
            'ts-autocode-harness': 'workspace:*',
            'ts-autocode-rewrite': 'workspace:*',
            'ts-autocode-training': 'workspace:*',
          },
        },
      },
    });
    expect(message).toContain(
      'the override "ts-autocode-grounding" is "0.1.0" in the project and "workspace:*" in pnpm-lock.yaml',
    );
  });

  it('reads overrides from pnpm-workspace.yaml over package.json, and resolutions under both', async () => {
    const world = await worldOf(HOBO, {
      root: {
        resolutions: { 'ts-autocode-grounding': '9.9.9' },
        pnpm: { overrides: { 'ts-autocode-grounding': '8.8.8' } },
      },
      workspaceYaml:
        'overrides:\n  ts-autocode-grounding: workspace:*\n  ts-autocode-harness: workspace:*\n  ts-autocode-rewrite: workspace:*\n  ts-autocode-training: workspace:*\n',
    });
    await expect(world.read()).resolves.toMatchObject({ refused: [] });
  });

  it("applies the overrides to the importers' own specifiers, as pnpm does", async () => {
    // external/ts-autocode asks for ts-autocode-rewrite@0.1.0 and the lock
    // records workspace:* because the root overrides it.
    const world = await worldOf(HOBO, {
      manifest: (id, manifest) =>
        id === 'external/ts-autocode/packages/training'
          ? {
              ...manifest,
              devDependencies: {
                ...(manifest['devDependencies'] as Record<string, string>),
                'ts-autocode-rewrite': '0.1.0',
              },
            }
          : manifest,
    });
    await expect(world.read()).resolves.toMatchObject({ refused: [] });
  });

  it('is stale when a catalog entry differs', async () => {
    const lock = LOCK(`catalogs:

  default:
    left:
      specifier: ^1.0.0
      version: 1.0.0

importers:

  .:
    dependencies:
${dependency('left', 'catalog:', '1.0.0')}
packages:

${pkg('left@1.0.0')}

snapshots:

  left@1.0.0: {}
`);
    const message = await stale(lock, {
      workspaceYaml: 'catalog:\n  left: ^2.0.0\n',
      manifest: (_id, manifest) => ({
        ...manifest,
        dependencies: { left: 'catalog:' },
      }),
    });
    expect(message).toContain(
      'the catalog "default" has "left" as "^2.0.0" in the project and "^1.0.0" in pnpm-lock.yaml',
    );
    const fine = await worldOf(lock, {
      workspaceYaml: 'catalog:\n  left: ^1.0.0\n',
      manifest: (_id, manifest) => ({
        ...manifest,
        dependencies: { left: 'catalog:' },
      }),
    });
    await expect(fine.read()).resolves.toMatchObject({ refused: [] });
  });

  it('is stale when the project declares a patch, which opm does not apply', async () => {
    const message = await stale(AI_BDD, {
      root: {
        pnpm: { patchedDependencies: { 'semver@7.7.2': 'patches/s.patch' } },
      },
    });
    expect(message).toContain(
      'the project declares a patch for "semver@7.7.2", which opm does not apply',
    );
  });
});
