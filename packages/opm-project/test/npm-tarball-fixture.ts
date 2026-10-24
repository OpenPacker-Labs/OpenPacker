import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { packTarGzip } from '@openpacker/project-io';

/**
 * The archives the stand-in npm registry (`npm-registry-fixture.ts`) serves: a
 * real, if tiny, gzipped ustar tarball per version, built once and kept.
 */

/** What a fixture version puts in its archive besides `package.json`. */
export interface TarballContents {
  /** Files in the archive besides package.json, which is written for it. */
  files?: Record<string, string | Uint8Array>;
  /** `bin` for the package.json inside the archive. */
  bin?: string | Record<string, string>;
  /** The tarball's bytes exactly, instead of an archive made from the above. */
  archive?: Uint8Array;
}

/** A ustar entry: a 512-byte header, the body, and padding to a block. */
export function tarEntry(path: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0' + '00', 257, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

/**
 * A gzipped ustar archive whose paths are written exactly as given, which
 * `packTarGzip` refuses to do for `package/./dist/index.js`, though a published
 * package (agent-base@7.1.4) is spelled that way.
 */
export function rawTarball(
  entries: readonly { path: string; body: string }[],
): Uint8Array {
  return new Uint8Array(
    gzipSync(
      Buffer.concat([
        ...entries.map((entry) =>
          tarEntry(entry.path, Buffer.from(entry.body)),
        ),
        Buffer.alloc(1024),
      ]),
    ),
  );
}

/** A real (if tiny) npm tarball: gzip of a ustar archive of package/package.json. */
export function tarball(name: string, version: string): Uint8Array {
  return rawTarball([
    { path: 'package/package.json', body: JSON.stringify({ name, version }) },
  ]);
}

const tarballs = new Map<string, Uint8Array>();
export function tarballOf(
  name: string,
  version: string,
  value: TarballContents = {},
): Uint8Array {
  if (value.archive !== undefined) return value.archive;
  const key = `${name}@${version}:${JSON.stringify(
    [value.files, value.bin],
    (_key, item) =>
      item instanceof Uint8Array
        ? `bytes:${item.length}:${createHash('sha1').update(item).digest('hex')}`
        : item,
  )}`;
  let bytes = tarballs.get(key);
  if (bytes === undefined) {
    const literalPaths = Object.keys(value.files ?? {}).some((path) =>
      path.startsWith('./'),
    );
    bytes =
      value.files === undefined && value.bin === undefined
        ? tarball(name, version)
        : literalPaths
          ? rawTarball([
              {
                path: 'package/package.json',
                body: JSON.stringify({ name, version, main: 'index.js' }),
              },
              ...Object.entries(value.files ?? {}).map(([path, contents]) => ({
                path: `package/${path}`,
                body: String(contents),
              })),
            ])
          : packTarGzip(
              Object.entries({
                'package.json': JSON.stringify({
                  name,
                  version,
                  main: 'index.js',
                  ...(value.bin !== undefined && { bin: value.bin }),
                }),
                'index.js': `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`,
                ...value.files,
              }).map(([path, contents]) => ({
                path: `package/${path}`,
                contents:
                  typeof contents === 'string'
                    ? new TextEncoder().encode(contents)
                    : contents,
                executable: path === value.bin || path.startsWith('bin/'),
              })),
            );
    tarballs.set(key, bytes);
  }
  return bytes;
}
