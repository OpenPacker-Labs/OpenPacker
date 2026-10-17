import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { installFromLock, projectNativeFormats } from '../src/index.js';
import { assertLockMatchesManifest } from '../src/project.js';
import { lockOf } from './closure-support.js';

configureDefaultAdapters();

/**
 * A manifest spells an npm scope with a literal `@` (`pkg:npm/@isaacs/cliui`),
 * the lock with the canonical `%40`. They name one package, and a lock the
 * manifest produced is still its lock: `opm install` after `opm add` of a
 * scoped package was refused with "Lock package ... does not match manifest
 * PURL".
 */
describe('a scoped package the manifest spells with a literal @', () => {
  const registry = [
    { name: '@scope/tool', versions: { '1.0.0': { files: {} } } },
  ];
  const requirement = (version?: string) => ({
    tool: {
      alias: 'tool',
      purl: 'pkg:npm/@scope/tool',
      ...(!(version === undefined) && { version }),
    },
  });

  it('is the package its lock holds, with a version', async () => {
    const made = await lockOf(registry, requirement('1.0.0'));
    expect(made.lock.packages.tool?.purl).toBe('pkg:npm/%40scope/tool@1.0.0');
    expect(() =>
      assertLockMatchesManifest(made.root, made.manifest, made.lock),
    ).not.toThrow();
  });

  it('is the package its lock holds, without one', async () => {
    const made = await lockOf(registry, requirement());
    expect(() =>
      assertLockMatchesManifest(made.root, made.manifest, made.lock),
    ).not.toThrow();
  });

  it('is still refused when the lock holds another package', async () => {
    const made = await lockOf(
      [...registry, { name: '@scope/other', versions: { '1.0.0': {} } }],
      requirement('1.0.0'),
    );
    const swapped = {
      ...made.lock,
      packages: {
        tool: {
          ...made.lock.packages.tool!,
          purl: 'pkg:npm/%40scope/other@1.0.0',
        },
      },
    };
    expect(() =>
      assertLockMatchesManifest(made.root, made.manifest, swapped),
    ).toThrow(/does not match manifest PURL/u);
  });

  it("is the project's own dependency in the layout, so what it needs is placed from it", async () => {
    // Taken for a transitive package, it had no root to be placed from, and
    // each version an alias of its closure needs was reported as set aside.
    const made = await lockOf(
      [
        {
          name: '@scope/app',
          versions: {
            '1.0.0': {
              dependencies: { dep: '^2', 'dep-old': 'npm:dep@^1' },
              files: {},
            },
          },
        },
        { name: 'dep', versions: { '1.0.0': {}, '2.0.0': {} } },
      ],
      {
        app: { alias: 'app', purl: 'pkg:npm/@scope/app', version: '1.0.0' },
      },
    );
    await installFromLock({
      root: made.root,
      lock: made.lock,
      offline: false,
      policy: made.manifest.policy!,
    });
    const report = await projectNativeFormats({
      root: made.root,
      manifest: made.manifest,
      lock: made.lock,
    });
    expect(report?.projections.flatMap((item) => item.skipped ?? [])).toEqual(
      [],
    );
    const version = async (name: string) =>
      JSON.parse(
        await readFile(
          join(made.root, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      ).version;
    expect(await version('dep')).toBe('2.0.0');
    expect(await version('dep-old')).toBe('1.0.0');
  });
});
