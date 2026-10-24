import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  collectGarbage,
  importNativeProject,
  initProject,
  installFrozen,
  installProject,
  listGenerations,
  projectPaths,
  readEnvironmentState,
  readManifestFile,
  recoverInterruptedSteps,
  removePackage,
  switchGeneration,
  syncProject,
  uninstallProject,
  updateProject,
  writeManifestFile,
  type RecoveredStep,
  type StepOptions,
} from '../src/index.js';
import {
  copies,
  deadCopy,
  project,
  stepLocks,
  transport,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * Every library function that changes a project finishes what a killed step
 * left first, and says so through `step.onRecovered`. One that did not would
 * leave the dead copy in place, and the next step would put it back over what
 * this one did.
 */

const read = (root: string, name: string) =>
  readFile(join(root, name), 'utf8').catch(() => '(absent)');

interface Entry {
  name: string;
  /** The packages the project starts with; base and other by default. */
  packages?: string[];
  /** Run before the copy is taken: the copy keeps what this sets up. */
  prepare?: (root: string) => Promise<void>;
  run: (root: string, step: StepOptions) => Promise<object>;
  /** What the step did, which must outlast the next recovery. */
  effect: (root: string) => Promise<void>;
}

const entries: Entry[] = [
  {
    name: 'initProject --force',
    run: (root, step) =>
      initProject({ root, name: 'after', force: true, step }),
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('name = "after"'),
  },
  {
    name: 'importNativeProject --force',
    prepare: (root) =>
      writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'imported', dependencies: { third: '^1.0.0' } }),
      ),
    run: (root, step) => importNativeProject({ root, force: true, step }),
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('pkg:npm/third'),
  },
  {
    name: 'addPackage',
    run: (root, step) =>
      addPackage({
        root,
        spec: 'pkg:npm/third@1.0.0',
        registryOptions: transport(),
        step,
      }),
    effect: async (root) => {
      expect(await read(root, 'opm.toml')).toContain('pkg:npm/third');
      expect(existsSync(join(root, 'node_modules', 'third'))).toBe(true);
    },
  },
  {
    name: 'removePackage',
    run: (root, step) => removePackage({ root, alias: 'other', step }),
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).not.toContain('pkg:npm/other'),
  },
  {
    name: 'syncProject',
    prepare: async (root) => {
      const paths = projectPaths(root);
      const manifest = await readManifestFile(paths.manifest);
      manifest.packages.third = {
        alias: 'third',
        purl: 'pkg:npm/third',
        version: '1.0.0',
      };
      await writeManifestFile(paths.manifest, manifest);
    },
    run: (root, step) =>
      syncProject({ root, registryOptions: transport(), step }),
    effect: async (root) =>
      expect(await read(root, 'opm.lock.json')).toContain(
        'pkg:npm/third@1.0.0',
      ),
  },
  {
    name: 'updateProject',
    prepare: async (root) => {
      const paths = projectPaths(root);
      const manifest = await readManifestFile(paths.manifest);
      manifest.packages.base!.version = '^1.0.0';
      await writeManifestFile(paths.manifest, manifest);
    },
    run: (root, step) =>
      updateProject({ root, registryOptions: transport(), step }),
    effect: async (root) =>
      expect(await read(root, 'opm.lock.json')).toContain('pkg:npm/base@1.1.0'),
  },
  {
    // With no lock, install resolves one: a step inside a step, which neither
    // locks nor recovers again.
    name: 'installProject',
    packages: [],
    prepare: (root) => rm(join(root, 'opm.lock.json')),
    run: (root, step) => installProject({ root, step }),
    effect: async (root) =>
      expect(await read(root, 'opm.lock.json')).toContain('"packages": {}'),
  },
  {
    name: 'uninstallProject',
    run: (root, step) => uninstallProject({ root, step }),
    effect: async (root) =>
      expect(await read(root, '.opm/project.json')).not.toContain('"base"'),
  },
  {
    name: 'switchGeneration',
    run: (root, step) => switchGeneration({ root, target: 1, step }),
    effect: async (root) => {
      const [first] = await listGenerations(root);
      expect((await readEnvironmentState(root))?.currentGenerationDigest).toBe(
        first?.generationDigest,
      );
    },
  },
  {
    name: 'collectGarbage',
    run: (root, step) => collectGarbage({ root, keep: 1, step }),
    effect: async (root) => expect(await listGenerations(root)).toHaveLength(1),
  },
  {
    name: 'installFrozen',
    prepare: async (root) => {
      await writeFile(
        join(root, 'package.json'),
        '{"name":"frozen","version":"1.0.0"}\n',
      );
      await writeFile(
        join(root, 'package-lock.json'),
        `${JSON.stringify({
          name: 'frozen',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'frozen', version: '1.0.0' } },
        })}\n`,
      );
    },
    run: (root, step) => installFrozen({ root, offline: true, step }),
    // The lock is the whole tree, and it names nothing.
    effect: async (root) =>
      expect(existsSync(join(root, 'node_modules', 'base'))).toBe(false),
  },
];

describe('a library step after a step a killed process left', () => {
  for (const entry of entries)
    it(`${entry.name} puts the project back first, once, and keeps its own change`, async () => {
      const root = await project(entry.packages ?? ['base', 'other']);
      await entry.prepare?.(root);
      const name = await deadCopy(root);
      const told: RecoveredStep[] = [];
      await entry.run(root, { onRecovered: (step) => told.push(step) });
      expect(told).toEqual([
        expect.objectContaining({ copy: join('.opm', name), restored: true }),
      ]);
      expect(await copies(root)).toEqual([]);
      expect(await stepLocks(root)).toEqual([]);
      await entry.effect(root);
      expect(await recoverInterruptedSteps(root)).toEqual([]);
      await entry.effect(root);
    });
});

describe('a host package added as a dry run', () => {
  it('changes nothing, so it neither recovers nor locks', async () => {
    const root = await project([]);
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.project.ecosystems = ['npm', 'deb'];
    await writeManifestFile(paths.manifest, manifest);
    const name = await deadCopy(root);
    const result = await addPackage({
      root,
      spec: 'pkg:deb/curl',
      dryRun: true,
      allowElevation: true,
      offline: true,
    });
    expect(result.hostInstall?.outcome).toBeUndefined();
    expect(await copies(root)).toEqual([name]);
    expect(await stepLocks(root)).toEqual([]);
  });
});
