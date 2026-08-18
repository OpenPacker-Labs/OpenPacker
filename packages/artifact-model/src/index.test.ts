import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ArtifactIntegrityError,
  collectStream,
  descriptorForBytes,
  digestString,
  streamFromBytes,
  validateDigest,
  validateRange,
  verifyBytes,
} from './index.js';

describe('artifact model', () => {
  it('keeps deterministic native archive fixtures fresh', () => {
    const rootScript = resolve(
      process.cwd(),
      'fixtures/artifacts/generate.mjs',
    );
    const script = existsSync(rootScript)
      ? rootScript
      : resolve(process.cwd(), '../../fixtures/artifacts/generate.mjs');
    const result = spawnSync(process.execPath, [script, '--check'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('describes and verifies exact native bytes', async () => {
    const bytes = new TextEncoder().encode('native bytes stay native\n');
    const descriptor = await descriptorForBytes({
      bytes,
      descriptorId: 'fixture',
      mediaType: 'application/octet-stream',
      artifactType: 'application/vnd.openpacker.package',
      nativeRole: 'package',
    });
    await expect(verifyBytes(descriptor, bytes)).resolves.toBeUndefined();
    await expect(
      verifyBytes(descriptor, new TextEncoder().encode('changed')),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(
      collectStream(streamFromBytes(bytes), bytes.byteLength),
    ).resolves.toEqual(bytes);
  });

  it('rejects invalid and unbounded ranges', () => {
    expect(() => validateRange({ offset: -1 })).toThrow(RangeError);
    expect(() => validateRange({ offset: 0, length: 0 })).toThrow(RangeError);
  });

  it('fails closed on digest drift, stream limits, and cancellation', async () => {
    const bytes = new TextEncoder().encode('abc');
    const descriptor = await descriptorForBytes({
      bytes,
      descriptorId: 'fixture',
      mediaType: 'application/octet-stream',
      artifactType: 'application/vnd.openpacker.package',
      nativeRole: 'package',
      fileName: 'fixture.bin',
    });
    expect(digestString(descriptor.digest)).toMatch(/^sha256:/u);
    expect(() => validateDigest(descriptor.digest)).not.toThrow();
    await expect(
      verifyBytes(
        {
          ...descriptor,
          digest: { ...descriptor.digest, value: '0'.repeat(64) },
        },
        bytes,
      ),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(collectStream(streamFromBytes(bytes), 2)).rejects.toThrow(
      /exceeds/u,
    );
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      collectStream(streamFromBytes(bytes), 3, controller.signal),
    ).rejects.toThrow('cancelled');
  });
});
