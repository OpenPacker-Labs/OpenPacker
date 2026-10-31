/**
 * `openpacker materialize --install-prefix` writes where it is told, through
 * the bases the environment names (ADR 0034, trusted bases). Like `opm` and
 * `opmx`, it begins a command at its entry, so the project and the tree it
 * runs in are fenced before any base is resolved: a link a checkout commits
 * (`.cache -> /outside`) that `XDG_CACHE_HOME` names is not followed, and
 * nothing is extracted where it points.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../src/index.js';

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

/** A tar holding `package/index.js`. */
function archive(): Uint8Array {
  const header = Buffer.alloc(512);
  header.write('package/index.js', 0);
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
  data.write('x');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

const worlds: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(POSIX)(
  'openpacker materialize in a checkout that holds a link',
  () => {
    it('extracts nothing through a link the project holds where XDG_CACHE_HOME points', async () => {
      const world = await mkdtemp(
        join(await realpath(tmpdir()), 'cli-fenced-'),
      );
      worlds.push(world);
      // A project (no .git: an archive or a Docker context) committing
      // `.cache -> <world>/outside`, which the environment names its cache.
      const repo = join(world, 'repo');
      const outside = join(world, 'outside');
      await mkdir(repo);
      await mkdir(outside);
      await writeFile(join(repo, 'package.json'), '{}');
      await symlink(outside, join(repo, '.cache'));
      vi.stubEnv('HOME', join(world, 'home'));
      vi.stubEnv('XDG_CACHE_HOME', join(repo, '.cache'));
      const bytes = archive();
      const path = join(repo, 'archive.tar');
      await writeFile(path, bytes);
      vi.spyOn(process, 'cwd').mockReturnValue(repo);
      vi.stubGlobal('fetch', async () =>
        Response.json({
          descriptor: {
            descriptorId: 'fixture',
            mediaType: 'application/x-tar',
            artifactType: 'package',
            digest: {
              algorithm: 'sha256',
              value: createHash('sha256').update(bytes).digest('hex'),
            },
            size: bytes.byteLength,
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

      const code = await runCli(
        [
          'materialize',
          'pkg:generic/demo@1.0.0',
          '--install-prefix',
          join(repo, '.cache', 'prefix'),
        ],
        output,
      );
      expect(await readdir(outside, { recursive: true })).toEqual([]);
      expect(code, output.err).not.toBe(EXIT_CODES.success);
      expect(output.err).toMatch(/ENOTDIR|ELOOP|UNSAFE_PATH|link/u);
    });
  },
);
