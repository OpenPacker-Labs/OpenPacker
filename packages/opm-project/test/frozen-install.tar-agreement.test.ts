/**
 * The archives of a pnpm lock are read under npm's and pnpm's agreement (ADR
 * 0057 §8): one whose tar the two would end differently is refused, under the
 * package's name, before node_modules is written. Here the tar has no zero
 * block at its end: npm installs it, pnpm fails.
 */

import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { packTar } from '@openpacker/project-io';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';
import { sri } from './frozen-workspace-fixture.js';

afterEach(cleanup);

const url = 'https://registry.npmjs.org/odd/-/odd-1.0.0.tgz';
const lockFor = (bytes: Uint8Array) =>
  `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      odd:\n        specifier: ${url}\n        version: ${url}\n\npackages:\n\n  odd@${url}:\n    resolution: {integrity: ${sri(bytes)}, tarball: ${url}}\n    version: 1.0.0\n\nsnapshots:\n\n  odd@${url}: {}\n`;

describe('the tar of a pnpm lock archive', () => {
  it('is refused when npm and pnpm would end it differently', async () => {
    const tar = packTar([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode('{"name":"odd","version":"1.0.0"}'),
      },
    ]);
    // packTar ends with two zero blocks; without them pnpm reads past the end.
    const bytes = gzipSync(tar.subarray(0, tar.byteLength - 1024));
    const w = await pnpmWorld();
    w.registry.archives.set(url, bytes);
    w.importer('.', { dependencies: { odd: [url, url] } });
    await w.write({ lock: lockFor(bytes) });
    const error = await w.install().then(
      () => undefined,
      (thrown: Error & { code?: string }) => thrown,
    );
    expect(error?.message).toMatch(
      /^odd@.* cannot be extracted: Unsafe archive rejected \(TAR_AMBIGUOUS_END\): the data ends at offset 1024 with no zero block/u,
    );
    await expect(w.read('node_modules/odd/package.json')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
});
