/**
 * A delegated provider's executable is snapshotted into an unnamed O_TMPFILE
 * file and run from its /proc/self/fd path, which only Linux has. Elsewhere
 * that is said before the file is opened, with the platform and where to run
 * it, not as a late "not a stable executable". The platform is spoofed because
 * the refusals are for hosts this suite does not run on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DelegatedPackProviderManifest } from '@openpacker/contracts';
import {
  delegatedExecutionRefusal,
  openDelegatedExecutable,
  UNSUPPORTED_PLATFORM,
} from './executable.js';
import { ManifestPackagePacker } from './packer.js';

const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function spoofPlatform(value: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  restores.push(() => {
    if (original) Object.defineProperty(process, 'platform', original);
  });
}

function manifest(): DelegatedPackProviderManifest {
  return {
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
}

const target = {
  project: { root: '/project', manifestPath: '/project/test.pack' },
  target: { purlType: 'test', identifier: 'demo', version: '1.0.0' },
};

describe('delegated execution off Linux', () => {
  it('has nothing to refuse on Linux', () => {
    expect(delegatedExecutionRefusal('linux')).toBeUndefined();
  });

  it('names the platform and the missing pieces', () => {
    const refusal = delegatedExecutionRefusal('darwin');
    expect(refusal).toMatch(/need Linux/u);
    expect(refusal).toMatch(/O_TMPFILE/u);
    expect(refusal).toMatch(/macOS has neither/u);
    expect(refusal).toMatch(/Node cannot fexecve/u);
    expect(refusal).toMatch(/Run the delegated pack on a Linux host/u);
    expect(delegatedExecutionRefusal('win32')).toMatch(/Windows has neither/u);
  });

  it('refuses a snapshot before it looks at the file', async () => {
    spoofPlatform('darwin');
    // The path does not exist: reaching it would be an ENOENT, not this.
    const failure = await openDelegatedExecutable(
      '/nonexistent/test-pack',
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: UNSUPPORTED_PLATFORM });
    expect(String(failure)).toMatch(/macOS has neither/u);
  });

  it('reports the provider unavailable for that reason, and the way around it', async () => {
    spoofPlatform('darwin');
    const packer = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: '/nonexistent/test-pack',
    });
    const availability = await packer.available();
    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toMatch(/need Linux/u);
    expect(availability.reason).toMatch(
      /`opm pack test --package-version <version>` \(without --provider or --delegate\)/u,
    );
    expect(availability.reason).not.toMatch(/is not a stable executable/u);
  });

  it('fails a pack with that reason, not with a claim about the file', async () => {
    spoofPlatform('darwin');
    const packer = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: '/nonexistent/test-pack',
    });
    const failure = await packer
      .pack(target, { allowBuild: true })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: UNSUPPORTED_PLATFORM });
    expect(String(failure)).toMatch(
      /example\.test cannot pack here: Delegated provider executables need Linux/u,
    );
    expect(String(failure)).not.toMatch(/is not a stable executable/u);
  });

  it('still calls a missing file on Linux what it is', async () => {
    const packer = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: '/nonexistent/test-pack',
    });
    await expect(packer.available()).resolves.toMatchObject({
      available: false,
      reason: '/nonexistent/test-pack is not a stable executable',
    });
  });
});
