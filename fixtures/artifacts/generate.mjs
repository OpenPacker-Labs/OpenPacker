import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'upstream');
const utf8 = new TextEncoder();
const check = process.argv.includes('--check');

const octal = (value, width) =>
  utf8.encode(value.toString(8).padStart(width - 1, '0') + '\0');

function tar(entries) {
  const blocks = [];
  for (const [name, text, mode = 0o644] of entries) {
    const data = utf8.encode(text);
    const header = new Uint8Array(512);
    header.set(utf8.encode(name), 0);
    header.set(octal(mode, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(data.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(utf8.encode('ustar\0'), 257);
    header.set(utf8.encode('00'), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(utf8.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concatenate(blocks);
}

function gzipTar(entries) {
  const bytes = new Uint8Array(gzipSync(tar(entries), { level: 0 }));
  bytes[9] = 255; // deterministic unknown OS marker
  return bytes;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, text, mode = 0o644] of entries) {
    const nameBytes = utf8.encode(name);
    const data = utf8.encode(text);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x21, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x0314, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x21, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(38, (0o100000 | mode) << 16, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const central = concatenate(centralParts);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, central.length, true);
  view.setUint32(16, offset, true);
  return concatenate([...localParts, central, eocd]);
}

function concatenate(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const artifacts = [
  {
    file: 'cargo-zstd-wasm-1.0.0.native-bytes',
    exactPurl: 'pkg:cargo/openpacker-zstd-wasm@1.0.0',
    mediaType: 'application/vnd.crates.io.crate+gzip',
    bytes: gzipTar([
      ['openpacker-zstd-wasm-1.0.0/Cargo.toml', '[package]\nname = "openpacker-zstd-wasm"\nversion = "1.0.0"\nedition = "2024"\n'],
      ['openpacker-zstd-wasm-1.0.0/src/lib.rs', 'pub fn fixture() -> &\'static str { "zstd" }\n'],
    ]),
  },
  {
    file: 'npm-demo-1.0.0.native-bytes',
    exactPurl: 'pkg:npm/%40openpacker/demo-tool@1.0.0',
    mediaType: 'application/vnd.npm.package+gzip',
    bytes: gzipTar([
      ['package/package.json', '{"name":"@openpacker/demo-tool","version":"1.0.0","bin":{"openpacker-demo":"bin/openpacker-demo.js"}}\n'],
      ['package/bin/openpacker-demo.js', '#!/usr/bin/env node\nconsole.log("openpacker-demo-ok");\n', 0o755],
    ]),
  },
  {
    file: 'nuget-zstd-tool-1.0.0.native-bytes',
    exactPurl: 'pkg:nuget/OpenPacker.Zstd.Tool@1.0.0',
    mediaType: 'application/vnd.nuget.package+zip',
    bytes: zip([
      ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="nuspec" ContentType="application/octet"/></Types>'],
      ['OpenPacker.Zstd.Tool.nuspec', '<?xml version="1.0"?><package><metadata><id>OpenPacker.Zstd.Tool</id><version>1.0.0</version><authors>OpenPacker</authors><description>PREX fixture</description></metadata></package>'],
      ['tools/net8.0/any/openpacker-zstd.txt', 'openpacker-zstd-tool fixture\n'],
    ]),
  },
];

const manifest = {
  schemaVersion: '1',
  artifacts: artifacts.map(({ file, exactPurl, mediaType, bytes }) => ({
    file,
    exactPurl,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mediaType,
  })),
};
const outputs = [
  ...artifacts.map(({ file, bytes }) => [join(directory, file), bytes]),
  [join(directory, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
];

for (const [path, expected] of outputs) {
  if (check)
    assert.deepEqual(await readFile(path), Buffer.from(expected), `${path} is stale`);
  else await writeFile(path, expected);
}

console.log(check ? 'artifact fixtures are fresh' : 'artifact fixtures generated');
