import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { detectLockFormat, planLockCapture } from './index.js';

/**
 * What a real `package-lock.json` looks like to the importer: the project's own
 * entry, one package at several paths, links and workspace members. These
 * are the shapes that made every real lock be refused.
 */
describe('npm package-lock import', () => {
  configureDefaultAdapters();

  const sri = (seed: string) =>
    `sha512-${Buffer.from(seed.padEnd(64, '=')).toString('base64')}`;
  const entry = (
    name: string,
    version: string,
    extra: Record<string, unknown> = {},
  ) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
    integrity: sri(`${name}@${version}`),
    ...extra,
  });
  const lock = (packages: Record<string, unknown>, version = 3) =>
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: version,
      requires: true,
      packages,
    });

  it('does not import the project itself as a package', async () => {
    const plan = await planLockCapture(
      lock({
        '': { name: 'app', version: '1.0.0', dependencies: { a: '^1.0.0' } },
        'node_modules/a': entry('a', '1.0.0'),
      }),
    );
    expect(plan.lockedExactPurls).toEqual(['pkg:npm/a@1.0.0']);
  });

  it('captures a package placed at several paths as one selection', async () => {
    const shared = entry('c', '2.0.0', { dependencies: { d: '^1.0.0' } });
    const plan = await planLockCapture(
      lock({
        '': { name: 'app', version: '1.0.0' },
        'node_modules/a': entry('a', '1.0.0', {
          dependencies: { c: '^2.0.0' },
        }),
        'node_modules/a/node_modules/c': shared,
        'node_modules/b': entry('b', '1.0.0', {
          dependencies: { c: '^2.0.0' },
        }),
        'node_modules/b/node_modules/c': shared,
        'node_modules/c': entry('c', '1.0.0'),
        'node_modules/d': entry('d', '1.0.0'),
      }),
    );
    expect(plan.lockedExactPurls).toEqual([
      'pkg:npm/a@1.0.0',
      'pkg:npm/b@1.0.0',
      'pkg:npm/c@1.0.0',
      'pkg:npm/c@2.0.0',
      'pkg:npm/d@1.0.0',
    ]);
    const placed = plan.lockCapture.packages.find(
      (pkg) => pkg.exactPurl === 'pkg:npm/c@2.0.0',
    );
    expect(placed?.native).toMatchObject({
      path: 'node_modules/a/node_modules/c',
      paths: ['node_modules/a/node_modules/c', 'node_modules/b/node_modules/c'],
    });
  });

  it('keeps a package dev-only only if every placement is', async () => {
    const plan = await planLockCapture(
      lock({
        '': { name: 'app', version: '1.0.0' },
        'node_modules/a': entry('a', '1.0.0'),
        'node_modules/a/node_modules/c': entry('c', '1.0.0', { dev: true }),
        'node_modules/c': entry('c', '1.0.0'),
      }),
    );
    const captured = plan.lockCapture.packages.find(
      (pkg) => pkg.exactPurl === 'pkg:npm/c@1.0.0',
    );
    expect(captured?.native).toMatchObject({ dev: false });
  });

  it('still refuses one package locked two ways', async () => {
    const base = {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/a': entry('a', '1.0.0'),
    };
    await expect(
      planLockCapture(
        lock({
          ...base,
          'node_modules/c': entry('c', '1.0.0'),
          'node_modules/a/node_modules/c': {
            ...entry('c', '1.0.0'),
            integrity: sri('something else'),
          },
        }),
      ),
    ).rejects.toThrow(/c@1\.0\.0 is locked with a different integrity/u);
    await expect(
      planLockCapture(
        lock({
          ...base,
          'node_modules/c': entry('c', '1.0.0'),
          'node_modules/a/node_modules/c': {
            ...entry('c', '1.0.0'),
            resolved: 'https://registry.npmjs.org/c/-/c-1.0.0-other.tgz',
          },
        }),
      ),
    ).rejects.toThrow(/different resolved URL/u);
  });

  it('refuses a lock that lists a path twice', async () => {
    const text = lock({
      '': { name: 'app', version: '1.0.0' },
      'node_modules/a': entry('a', '1.0.0'),
    }).replace(
      '"node_modules/a":',
      '"node_modules/a":{"version":"9.9.9"},"node_modules/a":',
    );
    await expect(
      planLockCapture(text, { format: 'package-lock' }),
    ).rejects.toThrow(/Map keys must be unique|duplicate/iu);
  });

  it('reads lockfileVersion 2, which npm 7 and 8 write', async () => {
    const text = lock(
      {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/a': entry('a', '1.0.0'),
      },
      2,
    );
    expect(detectLockFormat(text)).toBe('package-lock');
    const plan = await planLockCapture(text);
    expect(plan.lockedExactPurls).toEqual(['pkg:npm/a@1.0.0']);
    expect(plan.lockCapture.formatVersion).toBe('2');
  });

  it('refuses a lockfileVersion 1 lock, which has no packages section', async () => {
    const text = JSON.stringify({
      name: 'app',
      lockfileVersion: 1,
      dependencies: {},
    });
    expect(() => detectLockFormat(text)).toThrow(/detect/u);
    await expect(
      planLockCapture(text, { format: 'package-lock' }),
    ).rejects.toThrow(/lockfileVersion 1/u);
  });

  it('leaves links and workspace members out of the selections, and says so', async () => {
    const plan = await planLockCapture(
      lock({
        '': { name: 'app', version: '1.0.0', workspaces: ['packages/*'] },
        'node_modules/a': entry('a', '1.0.0'),
        'node_modules/member': { resolved: 'packages/member', link: true },
        'packages/member': { name: 'member', version: '0.1.0' },
        'packages/member/node_modules/x': entry('x', '1.0.0'),
      }),
    );
    expect(plan.lockedExactPurls).toEqual(['pkg:npm/a@1.0.0']);
    const lost = plan.semanticLoss
      .filter((loss) => loss.code === 'NPM_WORKSPACE_ENTRY_NOT_CAPTURED')
      .map((loss) => loss.sourcePath);
    expect(lost).toEqual([
      '/packages/node_modules/member',
      '/packages/packages/member',
      '/packages/packages/member/node_modules/x',
    ]);
  });
});
