import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { DEFAULT_MATERIALIZATION_LIMITS } from '@openpacker/materializer';
import { installArchiveLimits } from '../src/install-limits.js';
import { frozenArchiveLimits } from '../src/frozen-store.js';
import { installAndLayout, direct, lockOf } from './closure-support.js';

configureDefaultAdapters();

/**
 * `opm add` of a package whose archive is larger than the materializer's
 * defaults: the platform build of `@openai/codex` is 92 MB packed. `opm ci`
 * already extracts such a package; `opm add` refused it with
 * "Unsafe archive rejected (COMPRESSED_SIZE_LIMIT)".
 */
describe('the bounds an installed archive is extracted under', () => {
  it('are the bounds a frozen install extracts under', () => {
    expect(installArchiveLimits()).toEqual(
      frozenArchiveLimits({ acceptRedundantEntries: false }),
    );
    expect(installArchiveLimits().maximumCompressedBytes).toBeGreaterThan(
      DEFAULT_MATERIALIZATION_LIMITS.maximumCompressedBytes,
    );
  });

  it("read an npm archive as npm does, and no other ecosystem's", () => {
    expect(installArchiveLimits('npm')).toEqual(
      frozenArchiveLimits({ acceptRedundantEntries: true }),
    );
    expect(installArchiveLimits('cargo').acceptRedundantEntries).toBe(
      undefined,
    );
  });

  it('let a package published with ./ in its paths be installed (agent-base@7.1.4 is)', async () => {
    const made = await lockOf(
      [
        {
          name: 'agentish',
          versions: {
            '1.0.0': { files: { './dist/index.js': 'module.exports = 1;\n' } },
          },
        },
      ],
      direct('agentish', '1.0.0'),
    );
    await installAndLayout(made);
    expect(
      await readFile(
        join(made.root, 'node_modules', 'agentish', 'dist', 'index.js'),
        'utf8',
      ),
    ).toBe('module.exports = 1;\n');
  });

  it('let a package 66 MiB packed be installed', async () => {
    // Random bytes do not compress, so the archive is as large as the file.
    const payload = new Uint8Array(randomBytes(66 * 1024 * 1024));
    const made = await lockOf(
      [
        {
          name: 'big',
          versions: { '1.0.0': { files: { 'payload.bin': payload } } },
        },
      ],
      direct('big', '1.0.0'),
    );
    expect(made.lock.packages.big?.size).toBeGreaterThan(
      DEFAULT_MATERIALIZATION_LIMITS.maximumCompressedBytes,
    );
    await installAndLayout(made);
    expect(
      (await stat(join(made.root, 'node_modules', 'big', 'payload.bin'))).size,
    ).toBe(payload.byteLength);
  }, 120_000);

  it('let it be installed through the shared store too', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'opm-shared-limits-'));
    const before = process.env.OPM_STORE_HOME;
    process.env.OPM_STORE_HOME = shared;
    try {
      const payload = new Uint8Array(randomBytes(66 * 1024 * 1024));
      const made = await lockOf(
        [
          {
            name: 'big',
            versions: { '1.0.0': { files: { 'payload.bin': payload } } },
          },
        ],
        direct('big', '1.0.0'),
      );
      await installAndLayout(made);
      expect(
        (await stat(join(made.root, 'node_modules', 'big', 'payload.bin')))
          .size,
      ).toBe(payload.byteLength);
      // It was published to the shared store, not extracted beside the project.
      expect(
        (
          await stat(
            join(
              shared,
              `sha256-${made.lock.packages.big!.digest.slice('sha256:'.length)}`,
            ),
          )
        ).isDirectory(),
      ).toBe(true);
    } finally {
      if (before === undefined) delete process.env.OPM_STORE_HOME;
      else process.env.OPM_STORE_HOME = before;
      await rm(shared, { recursive: true, force: true });
    }
  }, 120_000);
});
