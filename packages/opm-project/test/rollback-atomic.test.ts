import {
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  projectPaths,
  readManifestFile,
  recoverInterruptedSteps,
  writeManifestFile,
} from '../src/index.js';
import {
  REGISTRY_PACKAGES,
  child,
  copies,
  deadCopy,
  ended,
  killingAt,
  project,
  snapshot,
  sources,
  temporary,
} from './rollback-support.js';

configureDefaultAdapters();

const fixture = join(import.meta.dirname, 'npm-registry-fixture.ts');
/** The adapters, by path: a child's script lives beside the project, not here. */
const adapters = join(
  import.meta.dirname,
  '../../adapters-default/dist/esm/index.js',
);

/**
 * A file is put back by writing a temporary name beside it and renaming that
 * over it, so a putting back killed at any point leaves opm.toml as it was or
 * as it was kept, never empty or half written; and a step killed part way
 * puts back only over what it wrote.
 */
describe.runIf(process.platform !== 'win32')(
  'a putting back killed before it renames a file into place',
  () => {
    it('leaves the file whole, and the next one finishes', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      await writeFile(join(root, 'opm.toml'), 'half-written\n');

      const killed = await child(
        root,
        `const { recoverInterruptedSteps } = await import(${JSON.stringify(sources.index)});
         await recoverInterruptedSteps(root);`,
        [],
        killingAt('rename', 'opm-restore', '/opm\\.toml$'),
      );
      expect(await ended(killed)).toEqual({ code: null, signal: 'SIGKILL' });
      // Neither empty nor partial: what the step left, and the kept file beside it.
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
        'half-written\n',
      );
      expect(await readFile(join(root, '.opm.toml.opm-restore'), 'utf8')).toBe(
        before.manifest,
      );

      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect(
        (await readdir(root)).filter((name) => name.endsWith('.opm-restore')),
      ).toEqual([]);
    }, 60_000);

    it('does not write through a link left where its temporary name goes', async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      await deadCopy(root);
      const outside = join(
        temporary(await mkdtemp(join(tmpdir(), 'opm-atomic-'))),
        'outside.txt',
      );
      await writeFile(outside, 'outside the project\n');
      await symlink(outside, join(root, '.opm.toml.opm-restore'));
      await writeFile(join(root, 'opm.toml'), 'half-written\n');
      await recoverInterruptedSteps(root);
      expect(await readFile(outside, 'utf8')).toBe('outside the project\n');
      expect(await snapshot(root)).toEqual(before);
    });
  },
);

describe.runIf(process.platform !== 'win32')(
  'a sync killed while it links',
  () => {
    it('is not put back over a hand edit of opm.toml made after it', async () => {
      const root = await project(['base']);
      const paths = projectPaths(root);
      // opm.toml asks for one more package, as a person edits it; sync installs it.
      const manifest = await readManifestFile(paths.manifest);
      manifest.packages.third = { alias: 'third', purl: 'pkg:npm/third' };
      await writeManifestFile(paths.manifest, manifest);

      const killed = await child(
        root,
        `const { syncProject } = await import(${JSON.stringify(sources.index)});
       const { configureDefaultAdapters } = await import(${JSON.stringify(adapters)});
       configureDefaultAdapters();
       const { NpmRegistryFixture } = await import(${JSON.stringify(fixture)});
       await syncProject({ root, registryOptions: { transport: new NpmRegistryFixture(${JSON.stringify(REGISTRY_PACKAGES)}) } });`,
        [],
        killingAt('mkdir', '^/proc/self/fd/\\d+/node_modules$'),
      );
      expect(await ended(killed)).toEqual({ code: null, signal: 'SIGKILL' });
      expect(await copies(root)).toHaveLength(1);

      // After the kill the person edits opm.toml again.
      const edited = `${await readFile(paths.manifest, 'utf8')}# edited by hand after the kill\n`;
      await writeFile(paths.manifest, edited);
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'ROLLBACK_CONFLICT',
        message: expect.stringContaining('opm.toml'),
      });
      expect(await readFile(paths.manifest, 'utf8')).toBe(edited);
      expect(await copies(root)).toHaveLength(1);
    }, 60_000);

    it('is put back when opm.toml is as the sync left it', async () => {
      const root = await project(['base']);
      const paths = projectPaths(root);
      const manifest = await readManifestFile(paths.manifest);
      manifest.packages.third = { alias: 'third', purl: 'pkg:npm/third' };
      await writeManifestFile(paths.manifest, manifest);
      const before = await snapshot(root);

      const killed = await child(
        root,
        `const { syncProject } = await import(${JSON.stringify(sources.index)});
       const { configureDefaultAdapters } = await import(${JSON.stringify(adapters)});
       configureDefaultAdapters();
       const { NpmRegistryFixture } = await import(${JSON.stringify(fixture)});
       await syncProject({ root, registryOptions: { transport: new NpmRegistryFixture(${JSON.stringify(REGISTRY_PACKAGES)}) } });`,
        [],
        killingAt('mkdir', '^/proc/self/fd/\\d+/node_modules$'),
      );
      expect(await ended(killed)).toEqual({ code: null, signal: 'SIGKILL' });
      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
    }, 60_000);
  },
);
