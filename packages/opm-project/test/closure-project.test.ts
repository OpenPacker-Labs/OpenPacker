import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  listInstalled,
  projectPaths,
  uninstallProject,
  whyPackage,
  writeLockfile,
  writeManifestFile,
} from '../src/index.js';
import { installAndLayout, lockOf } from './closure-support.js';
import { type FixturePackage } from './npm-registry-fixture.js';

configureDefaultAdapters();

/** What `opm why`, `opm list` and the executables say with a package twice. */

const vitestAndTinybench = (): FixturePackage[] => [
  {
    name: 'vitest',
    versions: { '4.1.9': { dependencies: { tinybench: '^2.9.0' }, files: {} } },
  },
  {
    name: 'tinybench',
    versions: { '2.9.0': { files: {} }, '6.2.2': { files: {} } },
  },
];

const both = {
  vitest: { alias: 'vitest', purl: 'pkg:npm/vitest', version: '4.1.9' },
  tinybench: {
    alias: 'tinybench',
    purl: 'pkg:npm/tinybench',
    version: '6.2.2',
  },
};

describe('a project that holds a package twice', () => {
  const setup = async () => {
    const made = await lockOf(vitestAndTinybench(), both);
    const paths = projectPaths(made.root);
    await writeManifestFile(paths.manifest, made.manifest);
    await writeLockfile(paths.lock, made.lock);
    await installAndLayout(made);
    return { ...made, paths };
  };

  it('why answers for the key, the name, and says who requires what', async () => {
    const { root } = await setup();
    const byName = await whyPackage(root, 'tinybench');
    // The direct one, because that is what the project calls tinybench.
    expect(byName).toContain('"tinybench" is a direct dependency in opm.toml');
    const transitive = await whyPackage(root, 'tinybench.2.9.0');
    expect(transitive).toContain(
      '"tinybench.2.9.0" is in opm.lock.json as transitive dependency',
    );
    expect(transitive).toContain('pkg:npm/tinybench@2.9.0');
    expect(transitive).toContain('required by vitest (pkg:npm/vitest@4.1.9)');
    await expect(whyPackage(root, 'nothing-like-it')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('list shows both versions as their own rows', async () => {
    const { root } = await setup();
    const rows = await listInstalled(root);
    expect(
      rows.map((row) => `${row.alias} ${row.purl} ${row.installed}`),
    ).toEqual([
      'tinybench pkg:npm/tinybench@6.2.2 true',
      'tinybench.2.9.0 pkg:npm/tinybench@2.9.0 true',
      'vitest pkg:npm/vitest@4.1.9 true',
    ]);
  });

  describe('executables, which are one file per name', () => {
    const tool = (text: string) => ({
      bin: { tool: 'bin/tool.js' },
      files: { 'bin/tool.js': `console.log(${text})\n` },
    });
    const registry = (): FixturePackage[] => [
      {
        name: 'cli-a',
        versions: { '1.0.0': { dependencies: { tool: '^1' } } },
      },
      {
        name: 'cli-b',
        versions: { '1.0.0': { dependencies: { tool: '^2' } } },
      },
      {
        name: 'tool',
        versions: { '1.0.0': tool('1'), '2.0.0': tool('2') },
      },
    ];
    interface State {
      packages: Record<string, { bins: { target: string }[] }>;
    }
    /** Whether the `tool` shim runs the target of the record under `key`. */
    const shimRuns = async (
      paths: ReturnType<typeof projectPaths>,
      key: string,
    ): Promise<boolean> => {
      const state = JSON.parse(
        await readFile(paths.projectState, 'utf8'),
      ) as State;
      const target = state.packages[key]!.bins[0]!.target;
      const body = await readFile(join(paths.bin, 'tool'), 'utf8');
      return body.includes(JSON.stringify(relative(paths.bin, target)));
    };

    it('gives the name to the last version by key, and back to the other when it goes', async () => {
      const made = await lockOf(registry(), {
        'cli-a': { alias: 'cli-a', purl: 'pkg:npm/cli-a', version: '1.0.0' },
        'cli-b': { alias: 'cli-b', purl: 'pkg:npm/cli-b', version: '1.0.0' },
      });
      await installAndLayout(made);
      const paths = projectPaths(made.root);
      expect(await shimRuns(paths, 'tool.2.0.0')).toBe(true);
      expect(await shimRuns(paths, 'tool.1.0.0')).toBe(false);
      await uninstallProject({ root: made.root, alias: 'tool.2.0.0' });
      expect(await shimRuns(paths, 'tool.1.0.0')).toBe(true);
    });

    it('gives the name to a direct requirement, whatever its key sorts as', async () => {
      const made = await lockOf(registry(), {
        'cli-b': { alias: 'cli-b', purl: 'pkg:npm/cli-b', version: '1.0.0' },
        tool: { alias: 'tool', purl: 'pkg:npm/tool', version: '1.0.0' },
      });
      await installAndLayout(made);
      const paths = projectPaths(made.root);
      // `tool` sorts before `tool.2.0.0`, so the transitive version would be
      // written last and win, if the order were only the keys'.
      expect(await shimRuns(paths, 'tool')).toBe(true);
      await uninstallProject({ root: made.root, alias: 'tool.2.0.0' });
      expect(await shimRuns(paths, 'tool')).toBe(true);
    });
  });
});
