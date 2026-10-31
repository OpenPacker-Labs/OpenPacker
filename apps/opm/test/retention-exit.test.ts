import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProviderError, type CatalogProvider } from '@openpacker/adapter-core';
import { EXIT_CODES } from '../src/opm.js';
import { moduleOf } from './hostile-adapter.js';
import { runWith } from './plain-fixture.js';

/**
 * What a script is told when a resolve's budget or its registry is the
 * problem. A budget the person wrote wrongly is a usage error (2), not an
 * internal one; a registry that changed a document while the resolve was
 * reading it is the registry's (8), like any other registry that cannot be
 * used for now, and the message says which package and what to do.
 */

const opm = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'opm.js',
);

async function binary(value: string) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-budget-'));
  try {
    return spawnSync(process.execPath, [opm, 'resolve', 'pkg:npm/left-pad'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        OPM_STORE_HOME: join(dir, '.store'),
        OPM_RETAINED_METADATA_MIB: value,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe(
  'a retention budget the person wrote wrongly',
  { timeout: 60_000 },
  () => {
    it('is a usage error, from the real binary', async () => {
      const ran = await binary('x');
      expect(ran.status, ran.stderr).toBe(EXIT_CODES.usage);
      expect(ran.stderr).toBe(
        'opm: OPM_RETAINED_METADATA_MIB must be a whole number of MiB or "unlimited", not "x".\n',
      );
    });

    it('is quoted on one line, whatever it holds', async () => {
      const ran = await binary('\u001b[31mred\u001b[0m\nINJECTED LINE');
      expect(ran.status).toBe(EXIT_CODES.usage);
      expect(ran.stderr.split('\n')).toHaveLength(2);
      expect(ran.stderr).not.toMatch(/^INJECTED/mu);
      expect(ran.stderr.endsWith('\n')).toBe(true);
    });
  },
);

describe('a registry that changed a document during the resolve', () => {
  it('exits as a registry that cannot be used, naming the package', async () => {
    const message =
      'The registry changed the packument of demo during the resolve; run it again';
    // SAFETY: only the operations the command calls before it fails are given.
    const catalog = {
      providerId: 'dev.test.hostile',
      capabilities: {
        operations: ['identify', 'enumerate', 'inspect', 'artifact'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async identify() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async enumerate() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async inspect() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async fetchArtifactRecord() {
        throw new ProviderError('STALE_METADATA', message);
      },
      async snapshot() {
        throw new ProviderError('STALE_METADATA', message);
      },
    } as unknown as CatalogProvider;
    const ran = await runWith({}, ['resolve', 'pkg:acme/demo'], {
      adapters: [moduleOf({ catalog })],
    });
    expect(ran.code, ran.err).toBe(EXIT_CODES.unavailable);
    expect(ran.err).toBe(`opm: ${message}\n`);
  });
});
