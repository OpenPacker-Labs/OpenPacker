import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { addPackage, projectPaths, writeManifestFile } from '../src/index.js';
import { assertLabelIsFree } from '../src/label-conflict.js';
import { project } from './closure-support.js';

configureDefaultAdapters();

/**
 * `opm add is-number@npm:is-odd` names a label of the project. When the label
 * already names another package, the add is refused instead of replacing it
 * (ADR 0054).
 */

const held = {
  'is-number': {
    alias: 'is-number',
    purl: 'pkg:npm/is-number',
    version: '7.0.0',
  },
};

describe('a label that already names another package', () => {
  it('is refused by opm add, and opm.toml is left as it was', async () => {
    const { root, manifest } = await project(held);
    const paths = projectPaths(root);
    await writeManifestFile(paths.manifest, manifest);
    const before = await readFile(paths.manifest, 'utf8');

    await expect(
      addPackage({
        root,
        spec: 'is-number@npm:is-odd@3.0.1',
        ecosystem: 'npm',
        offline: true,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringContaining(
        '"is-number" already names pkg:npm/is-number in opm.toml, and this would make it pkg:npm/is-odd',
      ),
    });
    expect(await readFile(paths.manifest, 'utf8')).toBe(before);
  });

  it('says what to do instead', async () => {
    const { manifest } = await project(held);
    expect(() =>
      assertLabelIsFree(manifest, 'is-number', 'pkg:npm/is-odd'),
    ).toThrow(/opm remove is-number.*--alias/su);
  });

  it('is not refused for the same package: that is an update', async () => {
    const { manifest } = await project(held);
    expect(() =>
      assertLabelIsFree(manifest, 'is-number', 'pkg:npm/is-number'),
    ).not.toThrow();
    // With a version in the purl, and a scope spelled either way.
    expect(() =>
      assertLabelIsFree(manifest, 'is-number', 'pkg:npm/is-number@8.0.0'),
    ).not.toThrow();
    const scoped = (
      await project({
        tool: { alias: 'tool', purl: 'pkg:npm/@scope/tool' },
      })
    ).manifest;
    expect(() =>
      assertLabelIsFree(scoped, 'tool', 'pkg:npm/%40scope/tool'),
    ).not.toThrow();
    expect(() =>
      assertLabelIsFree(scoped, 'tool', 'pkg:npm/%40other/tool'),
    ).toThrow(/already names/u);
  });

  it('is free when nothing has the label', async () => {
    const { manifest } = await project(held);
    expect(() =>
      assertLabelIsFree(manifest, 'is-odd', 'pkg:npm/is-odd'),
    ).not.toThrow();
  });
});
