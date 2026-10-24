/**
 * macOS only. The suites that run everywhere else bind the libc backend to
 * glibc; this one reads a provider's output through the real libSystem (CI: the
 * macOS leg of "CI build"). A failure names what it was doing: collection used
 * to join each artifact name onto `/dev/fd/N`, which names nothing on macOS
 * (ADR 0045), so `opm pack` ended in "ENOENT ... lstat '/dev/fd/N/<name>'".
 * The executable seams are injected, so nothing here is run or snapshotted.
 */

import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DelegatedPackProviderManifest } from '@openpacker/contracts';
import { openStablePath } from '@openpacker/project-io';
import { collectArtifacts, handleRelativeReads } from './collect.js';
import { openDelegatedExecutable, UNSUPPORTED_PLATFORM } from './executable.js';
import { ManifestPackagePacker } from './packer.js';

const manifest: DelegatedPackProviderManifest = {
  delegatedPackProviderVersion: '2',
  id: 'example.test',
  purlTypes: ['test'],
  detection: { manifestNames: ['test.pack'] },
  executable: 'test-pack',
  commands: [{ arguments: ['pack', '--out', '{outputDirectory}'] }],
  identityCommand: {
    arguments: ['identify', '--artifact', '{artifactPath}'],
  },
  authority: { build: false, network: 'never', environment: [] },
  artifacts: [
    {
      suffix: '.test',
      mediaType: 'application/x-test',
      nativeRole: 'distribution',
    },
  ],
};

const identity = {
  path: '/approved/test-pack',
  digest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
  device: 1n,
  inode: 2n,
  size: 3n,
  ctimeNanoseconds: 4n,
  mtimeNanoseconds: 5n,
};

const sandboxOutcome = (stdout = '') => ({
  exitCode: 0,
  stdout,
  stderr: '',
  backend: 'mock' as const,
  profile: 'package-exec' as const,
  enforced: true,
  containmentLimited: false,
  policyDigest: { algorithm: 'sha256' as const, value: '0'.repeat(64) },
  losses: [],
  degraded: false,
});

describe.skipIf(process.platform !== 'darwin')('pack on macOS', () => {
  let dir: string;
  beforeAll(async () => {
    // $TMPDIR is under /var, a symlink to /private/var; every component of the
    // path walked below is opened without following links.
    dir = await mkdtemp(join(await realpath(tmpdir()), 'op-pack-darwin-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collectArtifacts reads and hashes a provider output through libc openat', async () => {
    const out = join(dir, 'collect');
    await mkdir(out);
    await writeFile(join(out, 'a.test'), 'first');
    await writeFile(join(out, 'ignored.txt'), 'no');
    const handle = await openStablePath(out);
    try {
      const found = await collectArtifacts(
        handle,
        out,
        // SAFETY: only `artifacts` is read by a collection; the cast names that.
        { artifacts: manifest.artifacts } as never,
        {
          outputEntries: 8,
          artifacts: 8,
          artifactBytes: 1_024n,
          totalArtifactBytes: 4_096n,
          readChunkBytes: 4,
        },
        handleRelativeReads,
      );
      expect(found).toMatchObject([
        {
          outputName: 'a.test',
          size: 5,
          digest: `sha256:${createHash('sha256').update('first').digest('hex')}`,
        },
      ]);
    } finally {
      await handle.close();
    }
  });

  it('a pack runs end to end over the output directory it opened', async () => {
    const root = join(dir, 'project');
    const out = join(root, 'out');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'test.pack'), 'project');
    const packer = new ManifestPackagePacker(manifest, 'test', {
      executablePath: identity.path,
      inspectExecutable: async () => identity,
      sandboxRun: async (input) => {
        if (input.argv[1] === 'identify') {
          const bytes = await readFile(input.argv.at(-1)!);
          return sandboxOutcome(
            JSON.stringify({
              delegatedPackArtifactIdentityVersion: '1',
              exactPurl: 'pkg:test/demo@1.0.0',
              artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            }),
          );
        }
        await writeFile(join(out, 'demo.test'), 'native bytes');
        return sandboxOutcome();
      },
    });
    const result = await packer.pack(
      {
        project: { root, manifestPath: join(root, 'test.pack') },
        target: { purlType: 'test', identifier: 'demo', version: '1.0.0' },
      },
      { allowBuild: true, outputDirectory: out },
    );
    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toMatchObject([
      { outputName: 'demo.test', size: 12 },
    ]);
  });

  it('a delegated executable is refused as unsupported on macOS, not as ENOENT or a bad file', async () => {
    const failure = await openDelegatedExecutable(process.execPath).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: UNSUPPORTED_PLATFORM });
    expect(String(failure)).toMatch(/macOS has neither/u);
    expect(String(failure)).not.toMatch(/ENOENT|not a stable approved/u);
  });
});
