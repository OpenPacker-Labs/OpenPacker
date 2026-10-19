/**
 * What may follow a gzip stream in an archive. Node's zlib, which npm and pnpm
 * extract with, ignores zero bytes after a member (GNU tar wrote archives
 * padded to a 10,240-byte record: sylvester@0.0.21 is one) and decodes a
 * second member as more of the same stream. The materializer accepts both and
 * refuses every other trailing byte, by its offset.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { packTar } from '@openpacker/project-io';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  inspectArchive,
  materialize,
  type MaterializationLimits,
} from './index.js';

const text = (value: string) => new TextEncoder().encode(value);
const zeros = (length: number) => new Uint8Array(length);
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

const tar = packTar([
  {
    path: 'package/package.json',
    contents: text('{"name":"sylvester","version":"0.0.21"}'),
  },
  {
    path: 'package/lib/index.js',
    contents: text('exports.v = 1;\n'.repeat(40)),
  },
]);
const member = gzipSync(tar);
/** As GNU tar wrote sylvester@0.0.21: the stream, then zeros to a record. */
const padded = concat(member, zeros(10_240 - (member.byteLength % 10_240)));

const paths = async (bytes: Uint8Array, limits?: MaterializationLimits) =>
  (await inspectArchive(bytes, 'tar+gzip', limits)).map(({ path, data }) => [
    path,
    Buffer.from(data).toString(),
  ]);
const refusal = (bytes: Uint8Array, limits?: MaterializationLimits) =>
  inspectArchive(bytes, 'tar+gzip', limits).then(
    () => undefined,
    (error: Error & { code?: string }) => ({
      code: error.code,
      message: error.message,
    }),
  );

describe('bytes after a gzip stream', () => {
  it('extracts a stream followed by zero padding, as npm and pnpm do', async () => {
    expect(Buffer.from(gunzipSync(padded)).equals(Buffer.from(tar))).toBe(true);
    expect(await paths(padded)).toEqual(await paths(member));
    expect(await paths(concat(member, zeros(1)))).toEqual(await paths(member));
  });

  it('refuses other trailing bytes, naming where they start', async () => {
    const junk = concat(member, text('JUNK'));
    expect(() => gunzipSync(junk)).toThrow(/incorrect header check/u);
    expect(await refusal(junk)).toEqual({
      code: 'GZIP_TRAILING_DATA',
      message: expect.stringContaining(
        `4 bytes follow the gzip stream at offset ${member.byteLength}; the byte at offset ${member.byteLength} is 0x4a`,
      ) as string,
    });
  });

  it('refuses a non-zero byte behind the padding, which Node would ignore', async () => {
    const hidden = concat(member, zeros(5), text('JUNK'), zeros(3));
    expect(Buffer.from(gunzipSync(hidden)).equals(Buffer.from(tar))).toBe(true);
    expect(await refusal(hidden)).toMatchObject({
      code: 'GZIP_TRAILING_DATA',
      message: expect.stringContaining(
        `12 bytes follow the gzip stream at offset ${member.byteLength}; the byte at offset ${member.byteLength + 5} is 0x4a`,
      ) as string,
    });
  });

  it('refuses a second member behind the padding, which Node would drop', async () => {
    const extra = gzipSync(
      packTar([{ path: 'package/extra.js', contents: text('x') }]),
    );
    const hidden = concat(member, zeros(2), extra);
    expect(Buffer.from(gunzipSync(hidden)).equals(Buffer.from(tar))).toBe(true);
    expect(await refusal(hidden)).toMatchObject({
      code: 'GZIP_TRAILING_DATA',
      message: expect.stringContaining(
        `the byte at offset ${member.byteLength + 2} is 0x1f`,
      ) as string,
    });
  });

  it('decodes two members as one stream, as Node does, padded or not', async () => {
    const split = 700;
    const two = concat(
      gzipSync(tar.subarray(0, split)),
      gzipSync(tar.subarray(split)),
    );
    expect(Buffer.from(gunzipSync(two)).equals(Buffer.from(tar))).toBe(true);
    expect(await paths(two)).toEqual(await paths(member));
    expect(await paths(concat(two, zeros(300)))).toEqual(await paths(member));
  });

  it('refuses a damaged second member, naming where it starts', async () => {
    const damaged = concat(member, gzipSync(text('more')).subarray(0, 15));
    expect(() => gunzipSync(damaged)).toThrow(/unexpected end of file/u);
    expect(await refusal(damaged)).toEqual({
      code: 'INVALID_COMPRESSION',
      message: expect.stringContaining(
        `the gzip member at offset ${member.byteLength}`,
      ) as string,
    });
  });

  it('refuses padding with no stream before it', async () => {
    expect(await refusal(zeros(1024))).toMatchObject({
      code: 'INVALID_COMPRESSION',
    });
  });

  it('counts the padding toward the compressed size limit', async () => {
    const limits = {
      ...DEFAULT_MATERIALIZATION_LIMITS,
      maximumCompressedBytes: padded.byteLength,
    };
    expect(await paths(padded, limits)).toEqual(await paths(member));
    expect(await refusal(concat(padded, zeros(1)), limits)).toMatchObject({
      code: 'COMPRESSED_SIZE_LIMIT',
    });
  });

  it('measures the compression ratio without the padding', async () => {
    const expanded = packTar([
      { path: 'package/zeros', contents: zeros(64 * 1024) },
    ]);
    const bomb = gzipSync(expanded);
    const ratio = Math.ceil(expanded.byteLength / bomb.byteLength / 2);
    const limits = {
      ...DEFAULT_MATERIALIZATION_LIMITS,
      maximumCompressionRatio: ratio,
    };
    // Padded to four times its size, the archive is under the ratio overall.
    const cushioned = concat(bomb, zeros(bomb.byteLength * 3));
    expect(expanded.byteLength / cushioned.byteLength).toBeLessThan(ratio);
    expect(await refusal(cushioned, limits)).toMatchObject({
      code: 'COMPRESSION_RATIO_LIMIT',
    });
  });
});

describe('materializing a padded archive', () => {
  const source = (bytes: Uint8Array): ArtifactSource => ({
    async stat(value) {
      return { descriptor: value, rangeSupported: false };
    },
    async open() {
      return streamFromBytes(bytes);
    },
    async listReferrers() {
      return [];
    },
  });
  const descriptor = (bytes: Uint8Array) =>
    descriptorForBytes({
      bytes,
      descriptorId: 'fixture',
      mediaType: 'application/vnd.npm.package+gzip',
      artifactType: 'package',
      nativeRole: 'native-package',
    });

  it('extracts it under the digest of the padded bytes, and checks it first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-gzip-padding-'));
    try {
      const manifest = await materialize({
        source: source(padded),
        descriptor: await descriptor(padded),
        destination: join(root, 'ok'),
        format: 'tar+gzip',
      });
      expect(manifest.artifactSize).toBe(padded.byteLength);
      expect(
        await readFile(join(root, 'ok/package/package.json'), 'utf8'),
      ).toContain('sylvester');
      // Same length, one padding byte changed: the digest refuses it first.
      const changed = concat(padded.subarray(0, -1), text('J'));
      await expect(
        materialize({
          source: source(changed),
          descriptor: await descriptor(padded),
          destination: join(root, 'changed'),
          format: 'tar+gzip',
        }),
      ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
