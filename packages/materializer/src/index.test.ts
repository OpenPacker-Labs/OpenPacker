import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  descriptorForBytes,
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import type { ArtifactDescriptor } from '@openpacker/contracts';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  inspectArchive,
  materialize,
  validateArchivePath,
} from './index.js';

function tar(
  entries: readonly {
    name: string;
    type?: string;
    data?: string;
    mode?: number;
  }[],
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data ?? '');
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(entry.name), 0);
    const octal = (value: number, length: number): Uint8Array =>
      new TextEncoder().encode(
        value.toString(8).padStart(length - 1, '0') + '\0',
      );
    header.set(octal(entry.mode ?? 0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(data.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.set(
      new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '),
      148,
    );
    blocks.push(
      header,
      data,
      new Uint8Array((512 - (data.byteLength % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.byteLength, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.byteLength;
  }
  return bytes;
}

function fixtureSource(bytes: Uint8Array): {
  source: ArtifactSource;
  descriptor: Promise<ArtifactDescriptor>;
} {
  const descriptor = descriptorForBytes({
    bytes,
    descriptorId: 'fixture',
    mediaType: 'application/x-tar',
    artifactType: 'package',
    nativeRole: 'native-package',
  });
  return {
    descriptor,
    source: {
      async stat(value) {
        return { descriptor: value, rangeSupported: false };
      },
      async open() {
        return streamFromBytes(bytes);
      },
      async listReferrers() {
        return [];
      },
    },
  };
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

function storedZip(name: string, text: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(text);
  const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, 0x800, true);
  localView.setUint32(14, crc32(data), true);
  localView.setUint32(18, data.byteLength, true);
  localView.setUint32(22, data.byteLength, true);
  localView.setUint16(26, nameBytes.byteLength, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.byteLength);
  const central = new Uint8Array(46 + nameBytes.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 0x0314, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, 0x800, true);
  centralView.setUint32(16, crc32(data), true);
  centralView.setUint32(20, data.byteLength, true);
  centralView.setUint32(24, data.byteLength, true);
  centralView.setUint16(28, nameBytes.byteLength, true);
  centralView.setUint32(38, 0o100644 << 16, true);
  central.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, local.byteLength, true);
  const output = new Uint8Array(
    local.byteLength + central.byteLength + eocd.byteLength,
  );
  output.set(local);
  output.set(central, local.byteLength);
  output.set(eocd, local.byteLength + central.byteLength);
  return output;
}

describe('safe materialization', () => {
  it.each([
    '../escape',
    '/etc/passwd',
    'C:\\Windows\\system32',
    '\\\\server\\share',
    'a/../../b',
    'file:stream',
    'dir/file:$DATA',
  ])('rejects unsafe path %s', (path) => {
    expect(() => validateArchivePath(path)).toThrow();
  });

  it.each([
    { type: '2', code: 'SYMLINK_REJECTED' },
    { type: '1', code: 'HARDLINK_REJECTED' },
    { type: '3', code: 'SPECIAL_FILE_REJECTED' },
    { type: '6', code: 'SPECIAL_FILE_REJECTED' },
  ])('rejects $code entries before writing', async ({ type, code }) => {
    await expect(
      inspectArchive(tar([{ name: 'bad', type }]), 'tar'),
    ).rejects.toMatchObject({ code });
  });

  it('atomically creates a new isolated prefix with normalized permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-materialize-'));
    const destination = join(root, 'prefix');
    const bytes = tar([
      { name: 'bin/', type: '5' },
      { name: 'bin/demo', data: '#!/bin/sh\necho demo\n', mode: 0o4755 },
      { name: 'README', data: 'fixture\n' },
    ]);
    const fixture = fixtureSource(bytes);
    try {
      const manifest = await materialize({
        source: fixture.source,
        descriptor: await fixture.descriptor,
        destination,
        format: 'tar',
      });
      expect(
        await readFile(join(destination, 'bin', 'demo'), 'utf8'),
      ).toContain('echo demo');
      expect(manifest.files.find(({ path }) => path === 'bin/demo')?.mode).toBe(
        0o755,
      );
      expect(manifest.lifecycleScriptsExecuted).toBe(false);
      await expect(
        materialize({
          source: fixture.source,
          descriptor: await fixture.descriptor,
          destination,
          format: 'tar',
        }),
      ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces only an explicitly managed empty prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-managed-prefix-'));
    const destination = join(root, 'prefix');
    const fixture = fixtureSource(tar([{ name: 'bin/demo', data: 'ok\n' }]));
    try {
      await mkdir(destination);
      await materialize({
        source: fixture.source,
        descriptor: await fixture.descriptor,
        destination,
        format: 'tar',
        managedDestination: true,
      });
      expect(await readFile(join(destination, 'bin/demo'), 'utf8')).toBe(
        'ok\n',
      );
      await expect(
        materialize({
          source: fixture.source,
          descriptor: await fixture.descriptor,
          destination,
          format: 'tar',
          managedDestination: true,
        }),
      ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate and case-colliding paths', async () => {
    await expect(
      inspectArchive(
        tar([
          { name: 'a', data: '1' },
          { name: 'A', data: '2' },
        ]),
        'tar',
      ),
    ).rejects.toMatchObject({ code: 'CASE_COLLISION' });
    await expect(
      inspectArchive(
        tar([
          { name: 'same', data: '1' },
          { name: 'same', data: '2' },
        ]),
        'tar',
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_PATH' });
  });

  it('parses stored ZIP entries and rejects Windows escapes inside ZIP', async () => {
    await expect(
      inspectArchive(storedZip('bin/tool', 'ok'), 'zip'),
    ).resolves.toMatchObject([{ path: 'bin/tool', type: 'file' }]);
    await expect(
      inspectArchive(storedZip('C:\\outside', 'bad'), 'zip'),
    ).rejects.toMatchObject({ code: 'WINDOWS_ABSOLUTE_PATH' });
  });

  it('enforces compression, file-count, and expanded-size bomb limits', async () => {
    const bomb = gzipSync(
      tar([{ name: 'large', data: '0'.repeat(32 * 1024) }]),
    );
    await expect(
      inspectArchive(bomb, 'tar+gzip', {
        ...DEFAULT_MATERIALIZATION_LIMITS,
        maximumCompressionRatio: 2,
      }),
    ).rejects.toMatchObject({ code: 'COMPRESSION_RATIO_LIMIT' });
    await expect(
      inspectArchive(
        tar([
          { name: 'one', data: '1' },
          { name: 'two', data: '2' },
        ]),
        'tar',
        { ...DEFAULT_MATERIALIZATION_LIMITS, maximumFiles: 1 },
      ),
    ).rejects.toMatchObject({ code: 'FILE_COUNT_LIMIT' });

    const invalidAfterLimit = tar([
      { name: 'one', data: '1' },
      { name: 'two', data: '2' },
    ]);
    invalidAfterLimit[1024 + 148] = invalidAfterLimit[1024 + 148]! ^ 0xff;
    await expect(
      inspectArchive(invalidAfterLimit, 'tar', {
        ...DEFAULT_MATERIALIZATION_LIMITS,
        maximumFiles: 1,
      }),
    ).rejects.toMatchObject({ code: 'FILE_COUNT_LIMIT' });
    await expect(
      inspectArchive(tar([{ name: 'large', data: '12345' }]), 'tar', {
        ...DEFAULT_MATERIALIZATION_LIMITS,
        maximumExpandedBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'EXPANDED_SIZE_LIMIT' });
  });

  it('rejects a file used as an ancestor before materialization', async () => {
    await expect(
      inspectArchive(
        tar([
          { name: 'parent', data: 'file' },
          { name: 'parent/child', data: 'child' },
        ]),
        'tar',
      ),
    ).rejects.toMatchObject({ code: 'FILE_AS_DIRECTORY' });
  });

  it('drains gzip output concurrently and rejects a backpressure-sized bomb', async () => {
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024));
    await expect(
      inspectArchive(bomb, 'tar+gzip', {
        ...DEFAULT_MATERIALIZATION_LIMITS,
        maximumCompressionRatio: 2,
      }),
    ).rejects.toMatchObject({ code: 'COMPRESSION_RATIO_LIMIT' });
  });

  it('removes staging state after archive and digest failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-materialize-fail-'));
    try {
      const traversal = tar([{ name: '../outside', data: 'bad' }]);
      const fixture = fixtureSource(traversal);
      await expect(
        materialize({
          source: fixture.source,
          descriptor: await fixture.descriptor,
          destination: join(root, 'prefix'),
          format: 'tar',
        }),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
      expect(await readdir(root)).toEqual([]);

      const valid = tar([{ name: 'safe', data: 'ok' }]);
      const mismatch = fixtureSource(new Uint8Array(valid.byteLength));
      await expect(
        materialize({
          source: mismatch.source,
          descriptor: await fixtureSource(valid).descriptor,
          destination: join(root, 'prefix'),
          format: 'tar',
        }),
      ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels the source and removes staging after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-materialize-abort-'));
    const bytes = tar([{ name: 'safe', data: 'ok' }]);
    const descriptor = await fixtureSource(bytes).descriptor;
    const abort = new AbortController();
    let pull = 0;
    let cancelled = false;
    const source: ArtifactSource = {
      async stat(value) {
        return { descriptor: value, rangeSupported: false };
      },
      async open() {
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            pull += 1;
            if (pull === 1) {
              controller.enqueue(bytes.slice(0, 512));
              setTimeout(() => abort.abort(new Error('cancelled fixture')), 0);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(bytes.slice(512));
          },
          cancel() {
            cancelled = true;
          },
        });
      },
      async listReferrers() {
        return [];
      },
    };
    try {
      await expect(
        materialize({
          source,
          descriptor,
          destination: join(root, 'prefix'),
          format: 'tar',
          signal: abort.signal,
        }),
      ).rejects.toThrow('cancelled fixture');
      expect(cancelled).toBe(true);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a staging directory replaced before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpacker-materialize-race-'));
    const bytes = tar([{ name: 'safe', data: 'ok' }]);
    const descriptor = await fixtureSource(bytes).descriptor;
    let opened!: () => void;
    let release!: () => void;
    const sourceOpened = new Promise<void>((resolve) => (opened = resolve));
    const continueOpen = new Promise<void>((resolve) => (release = resolve));
    const source: ArtifactSource = {
      async stat(value) {
        return { descriptor: value, rangeSupported: false };
      },
      async open() {
        opened();
        await continueOpen;
        return streamFromBytes(bytes);
      },
      async listReferrers() {
        return [];
      },
    };
    try {
      const pending = materialize({
        source,
        descriptor,
        destination: join(root, 'prefix'),
        format: 'tar',
      });
      await sourceOpened;
      const staging = (await readdir(root)).find((name) =>
        name.startsWith('.prefix.openpacker-'),
      )!;
      await rename(join(root, staging), join(root, `${staging}.original`));
      await mkdir(join(root, staging));
      release();
      await expect(pending).rejects.toMatchObject({ code: 'UNSAFE_STAGING' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
