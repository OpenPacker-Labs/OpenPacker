/**
 * Which directory of an extracted tarball is the package: npm strips the first
 * path component of every entry, so a directory entry of its own (`other/`,
 * with no file in it) installs nothing and must not change where the package
 * is read from. Two top-level directories that both hold files stay a layout
 * difference ADR 0057 section 8 pins.
 */

import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, project } from './layout-write-links-support.js';

afterEach(cleanup);

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('the directory of a tarball that is the package', () => {
  it('is package/, however many directory entries with no file sit beside it', async () => {
    const p = await project();
    const dep = await p.store('dep');
    await mkdir(join(dep.storePath!, 'other'));
    await mkdir(join(dep.storePath!, 'nested', 'deeper'), { recursive: true });

    await p.write([dep], []);

    expect(await exists(join(p.modules, 'dep', 'index.js'))).toBe(true);
    expect(await exists(join(p.modules, 'dep', 'package.json'))).toBe(true);
    expect(await exists(join(p.modules, 'dep', 'package'))).toBe(false);
    expect(await exists(join(p.modules, 'dep', 'other'))).toBe(false);
  });

  it('is still the store root where a second top-level directory holds a file', async () => {
    const p = await project();
    const dep = await p.store('dep');
    await mkdir(join(dep.storePath!, 'other'));
    await writeFile(join(dep.storePath!, 'other', 'o.js'), 'o');

    await p.write([dep], []);

    expect(await exists(join(p.modules, 'dep', 'package', 'index.js'))).toBe(
      true,
    );
    expect(await exists(join(p.modules, 'dep', 'other', 'o.js'))).toBe(true);
  });
});
