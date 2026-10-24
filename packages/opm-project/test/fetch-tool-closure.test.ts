import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchTool } from '../src/index.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

/**
 * `fetchTool` solves the closure of the release it fetched and puts every
 * package of it in the tool cache with the edges the solve chose. The solve is
 * tested on its own (tool-pinned-version.test.ts); this is the call into it,
 * answered by a stand-in registry, with nothing on the network.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('fetchTool', () => {
  it('materialises the closure of the release it fetched, with its edges', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-fetch-closure-'));
    temps.push(cacheRoot);
    const registry = new NpmRegistryFixture([
      {
        name: 'say',
        versions: {
          '1.5.0': { dependencies: { width: '~2.1.1' } },
          '1.6.0': { dependencies: { width: '^4.2.3' } },
        },
      },
      { name: 'width', versions: { '2.1.1': {}, '4.2.3': {} } },
    ]);
    const tool = await fetchTool({
      purl: 'pkg:npm/say@1.5.0',
      cacheRoot,
      registryOptions: { transport: registry },
    });
    // The pinned release's own dependency, not the newest's, in the cache...
    expect(tool.closure.map((pkg) => pkg.exactPurl)).toEqual([
      'pkg:npm/say@1.5.0',
      'pkg:npm/width@2.1.1',
    ]);
    expect(tool.runtimePaths).toEqual(tool.closure.map((pkg) => pkg.storePath));
    // ...and each package told what it requires, for the layout.
    expect(tool.closure.map((pkg) => pkg.requires)).toEqual([
      { width: 'pkg:npm/width@2.1.1' },
      {},
    ]);
  });
});
