/**
 * An archive whose gzip stream is followed by zero bytes installs, as npm and
 * pnpm install it (sylvester@0.0.21 on the npm registry is one: GNU tar padded
 * the stream to a 10,240-byte record). Any other byte after the stream is
 * refused, and the refusal names the package and the offset. The integrity the
 * lock pins covers the padding, and is checked before anything is extracted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';
import { sri, tarballOf } from './frozen-workspace-fixture.js';

afterEach(cleanup);

const url = 'https://registry.npmjs.org/odd/-/odd-1.0.0.tgz';
const lockFor = (bytes: Uint8Array) =>
  `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      odd:\n        specifier: ${url}\n        version: ${url}\n\npackages:\n\n  odd@${url}:\n    resolution: {integrity: ${sri(bytes)}, tarball: ${url}}\n    version: 1.0.0\n\nsnapshots:\n\n  odd@${url}: {}\n`;

const archive = tarballOf({
  name: 'odd',
  version: '1.0.0',
  files: { 'index.js': 'module.exports = "odd";\n' },
});
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const padded = concat(
  archive,
  new Uint8Array(10_240 - (archive.byteLength % 10_240)),
);

/** Install `served` from the registry under a lock that pins `pinned`. */
async function install(served: Uint8Array, pinned = served) {
  const w = await pnpmWorld();
  w.registry.archives.set(url, served);
  w.importer('.', { dependencies: { odd: [url, url] } });
  await w.write({ lock: lockFor(pinned) });
  const result = await w.install().then(
    ({ installed }) => ({ installed, code: undefined, message: '' }),
    (thrown: Error & { code?: string }) => ({
      installed: 0,
      code: thrown.code,
      message: thrown.message,
    }),
  );
  return { w, result };
}

describe('an archive with bytes after its gzip stream', () => {
  it('installs one padded with zeros, as npm and pnpm do', async () => {
    const { w, result } = await install(padded);
    expect(result).toMatchObject({ installed: 1, code: undefined });
    expect(await w.read('node_modules/odd/index.js')).toBe(
      'module.exports = "odd";\n',
    );
  });

  it('refuses any other byte, naming the package and the offset', async () => {
    const { result } = await install(
      concat(archive, new TextEncoder().encode('JUNK')),
    );
    expect(result.code).toBe('UNSAFE_PATH');
    expect(result.message).toMatch(/^odd@.* cannot be extracted: /u);
    expect(result.message).toContain(
      `(GZIP_TRAILING_DATA): 4 bytes follow the gzip stream at offset ${archive.byteLength}`,
    );
  });

  it('checks the pinned integrity over the padding before extracting', async () => {
    // As long as the pinned archive, one padding byte changed.
    const changed = concat(padded.subarray(0, -1), new Uint8Array([0x4a]));
    const { w, result } = await install(changed, padded);
    expect(result.code).toBe('DIGEST_MISMATCH');
    await expect(w.read('node_modules/odd/index.js')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
