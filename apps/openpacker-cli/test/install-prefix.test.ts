/**
 * `openpacker materialize --install-prefix` extracts the artifact on this
 * machine, so it reads an npm package the way npm and pnpm do (ADR 0058 §8):
 * the npm adapter's artifacts are extracted with `requireNpmReaderAgreement`,
 * every other artifact under the materializer's general rule. The daemon only
 * returns the descriptor; it extracts nothing.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../src/index.js';
import { extractionLimits } from '../src/extraction.js';

function io(): CliIo & { out: string; err: string } {
  const result = {
    out: '',
    err: '',
    stdin: Readable.from([]),
    stdout: {
      write(value: string | Uint8Array) {
        result.out += value.toString();
        return true;
      },
    },
    stderr: {
      write(value: string | Uint8Array) {
        result.err += value.toString();
        return true;
      },
    },
  };
  return result;
}

/** A tar with one file, `solo.js`, which has no directory above it: npm's strip drops it, pnpm installs it. */
function soloArchive(): Uint8Array {
  const header = Buffer.alloc(512);
  header.write('solo.js', 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000001\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const data = Buffer.alloc(512);
  data.write('s');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function install(artifactType: string) {
  const root = await mkdtemp(join(tmpdir(), 'openpacker-cli-prefix-'));
  roots.push(root);
  const archive = soloArchive();
  const path = join(root, 'archive.tar');
  await writeFile(path, archive);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubGlobal('fetch', async () =>
    Response.json({
      descriptor: {
        descriptorId: 'fixture',
        mediaType: 'application/x-tar',
        artifactType,
        digest: {
          algorithm: 'sha256',
          value: createHash('sha256').update(archive).digest('hex'),
        },
        size: archive.byteLength,
        nativeRole: 'package-archive',
        fileName: 'archive.tar',
        locations: [
          {
            transport: 'file',
            uri: pathToFileURL(path).toString(),
            priority: 0,
            rangeSupported: false,
          },
        ],
        referrers: [],
        externalRefs: [],
      },
    }),
  );
  const output = io();
  const destination = join(root, 'prefix');
  const code = await runCli(
    ['materialize', 'pkg:npm/demo@1.0.0', '--install-prefix', destination],
    output,
  );
  const files = await readdir(destination).catch(() => []);
  return { code, output, files };
}

describe('openpacker materialize --install-prefix', () => {
  it('refuses an npm package that npm and pnpm would install differently', async () => {
    for (const type of [
      'application/vnd.openpacker.npm.package.v1+tgz',
      'application/vnd.openpacker.npm.package.v1',
    ]) {
      const { code, output, files } = await install(type);
      expect(code, type).not.toBe(EXIT_CODES.success);
      expect(output.err, type).toContain('TAR_AMBIGUOUS_PATH');
      expect(files, type).not.toContain('solo.js');
    }
  });

  it('reads any other package under the general rule', async () => {
    for (const type of [
      'package',
      'application/vnd.openpacker.cargo.package.v1',
    ]) {
      const { code, files } = await install(type);
      expect(code, type).toBe(EXIT_CODES.success);
      expect(files, type).toContain('solo.js');
    }
  });

  it('asks for the agreement of the npm adapter artifacts and of no others', () => {
    const limits = (artifactType: string) =>
      extractionLimits({ artifactType } as never).requireNpmReaderAgreement;
    expect(limits('application/vnd.openpacker.npm.package.v1+tgz')).toBe(true);
    expect(limits('application/vnd.openpacker.npm.package.v1')).toBe(true);
    expect(
      limits('application/vnd.openpacker.npm.packument.v1'),
    ).toBeUndefined();
    expect(limits('application/vnd.openpacker.npm')).toBeUndefined();
    expect(
      limits('application/vnd.openpacker.cargo.package.v1'),
    ).toBeUndefined();
    expect(limits('package')).toBeUndefined();
  });
});
