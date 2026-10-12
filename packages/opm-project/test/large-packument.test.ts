import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSupplyChainPolicyInput,
  resolveManifestToLock,
  type OpmManifest,
} from '../src/index.js';
import {
  NpmRegistryFixture,
  OLD,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * `opm add pkg:npm/typescript@5.9.3` failed with "Response exceeds 8388608
 * bytes": the abbreviated packument is 8.7 MB. `typescript` is in nearly every
 * project, and `next` (25.6 MB) is the largest of the ones tried. A package is
 * as heavy as its version list, so these fixtures are padded to the sizes and
 * value counts of the real documents; nothing else about them is unusual.
 */

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

const manifest = (): OpmManifest => ({
  project: { name: 'heavy', ecosystems: ['npm'] },
  packages: {
    heavy: { alias: 'heavy', purl: 'pkg:npm/heavy', version: '1.0.0' },
  },
  options: { offline: false, layout: 'opm' },
  policy: defaultSupplyChainPolicyInput(),
});

async function lockFor(registry: NpmRegistryFixture) {
  const root = await mkdtemp(join(tmpdir(), 'opm-heavy-'));
  try {
    return await resolveManifestToLock({
      root,
      manifest: manifest(),
      offline: false,
      registryOptions: { transport: registry },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const heavy = (extra: Partial<FixturePackage>): FixturePackage[] => [
  {
    name: 'heavy',
    versions: { '1.0.0': { dependencies: { light: '^1.0.0' } } },
    ...extra,
  },
  { name: 'light', versions: { '1.0.0': {} } },
];

describe(
  'a package whose packument is as heavy as a real one',
  { timeout: 60_000 },
  () => {
    it('locks the closure of a package the size of typescript, reading it once', async () => {
      const registry = new NpmRegistryFixture(
        heavy({ padding: { bytes: 8_728_082, values: 260_520 } }),
      );
      const lock = await lockFor(registry);
      expect(
        Object.values(lock.packages)
          .map((item) => item.purl)
          .sort(),
      ).toEqual(['pkg:npm/heavy@1.0.0', 'pkg:npm/light@1.0.0']);
      // Kept for the resolve, not fetched again at every use: the memo's ceiling
      // is the adapter's, not the 8 MiB it used to be.
      expect(registry.packumentRequests('heavy')).toBe(1);
    });

    it('reads the full packument of a package that changed inside the release window', async () => {
      // `typescript` is 15.8 MB and 538,245 values in full, over the 200,000
      // values a document used to be allowed. The publish time that proves the
      // release old enough is in it, and the failure was swallowed, so the
      // policy said only that the time "was not provided".
      const registry = new NpmRegistryFixture(
        heavy({
          modified: hoursAgo(2),
          time: { '1.0.0': OLD },
          padding: { bytes: 15_783_773, values: 538_245, only: 'full' },
        }),
      );
      const lock = await lockFor(registry);
      expect(lock.packages.heavy?.publishedAt).toBe(OLD);
      expect(registry.fullPackumentRequests()).toHaveLength(1);
    });

    it('refuses a packument over 64 MiB, naming the package and both numbers', async () => {
      const registry = new NpmRegistryFixture(
        heavy({ padding: { bytes: 64 * 1024 * 1024 + 1 } }),
      );
      await expect(lockFor(registry)).rejects.toMatchObject({
        code: 'UPSTREAM_RESPONSE_TOO_LARGE',
        message:
          'The packument of heavy is 67108865 bytes (64.00 MiB) and exceeds the ' +
          'limit of 67108864 bytes (64.00 MiB)',
      });
    });
  },
);
