#!/usr/bin/env node
/**
 * Fetch node-tar 7.5.22 (the line npm 11 ships) and the five packages it needs
 * from the npm registry into a scratch directory, with no package manager: each
 * tarball is checked against the sha512 pinned below, then unpacked with the
 * system `tar` into <dir>/node_modules/<name>. The directory to give the oracle
 * and the fuzz is <dir>/node_modules/tar.
 *
 *   NODE_USE_ENV_PROXY=1 node fetch-node-tar-7.mjs <empty or new directory>
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PINNED = [
  [
    'tar',
    '7.5.22',
    'sha512-MFO/QzvtAOmJbkhOaCTvbGcFN9L9b+JunIsDwaKljSOdcLMea3NJ1k9Usz/rjdfSXTq4dfzfeS7W4p4YOAAHeA==',
  ],
  [
    'minizlib',
    '3.1.0',
    'sha512-KZxYo1BUkWD2TVFLr0MQoM8vUUigWD3LlD83a/75BqC+4qE0Hb1Vo5v1FgcfaNXvfXzr+5EhQ6ing/CaBijTlw==',
  ],
  [
    'chownr',
    '3.0.0',
    'sha512-+IxzY9BZOQd/XuYPRmrvEVjF/nqj5kgT4kEq7VofrDoM1MxoRjEWkrCC3EtLi59TVawxTAn+orJwFQcrqEN1+g==',
  ],
  [
    'yallist',
    '5.0.0',
    'sha512-YgvUTfwqyc7UXVMrB+SImsVYSmTS8X/tSrtdNZMImM+n7+QTriRXyXim0mBrTXNeqzVF0KWGgHPeiyViFFrNDw==',
  ],
  [
    'minipass',
    '7.1.3',
    'sha512-tEBHqDnIoM/1rXME1zgka9g6Q2lcoCkxHLuc7ODJ5BxbP5d4c2Z5cGgtXAku59200Cx7diuHTOYfSBD8n6mm8A==',
  ],
  [
    '@isaacs/fs-minipass',
    '4.0.1',
    'sha512-wgm9Ehl2jpeqP3zw/7mo3kRHFp5MEDhqAdwy1fTGkHAwnkGOVsgpvQhL8B5n1qlb01jV3n/bI0ZfZp5lWA1k4w==',
  ],
];

const [directory] = process.argv.slice(2);
if (!directory) {
  console.error('usage: node fetch-node-tar-7.mjs <empty or new directory>');
  process.exit(2);
}
mkdirSync(directory, { recursive: true });
if (readdirSync(directory).length > 0) {
  console.error(`${directory} is not empty`);
  process.exit(2);
}

for (const [name, version, integrity] of PINNED) {
  const url = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (digest !== integrity)
    throw new Error(
      `${name}@${version}: ${digest} is not the pinned ${integrity}`,
    );
  const target = join(directory, 'node_modules', name);
  mkdirSync(target, { recursive: true });
  const archive = join(directory, 'archive.tgz');
  writeFileSync(archive, bytes);
  const unpacked = spawnSync(
    'tar',
    ['-xzf', archive, '-C', target, '--strip-components=1'],
    { stdio: 'inherit' },
  );
  if (unpacked.status !== 0)
    throw new Error(`${name}: tar exited ${unpacked.status}`);
  console.log(`${name}@${version} ${integrity.slice(0, 22)}...`);
}
console.log(`node-tar 7.5.22: ${join(directory, 'node_modules', 'tar')}`);
