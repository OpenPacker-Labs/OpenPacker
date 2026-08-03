#!/usr/bin/env node
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const packageRoot = resolve(import.meta.dirname, '..');
const platformLibrary = {
  linux: 'libopenpacker_wasm.so',
  darwin: 'libopenpacker_wasm.dylib',
  win32: 'openpacker_wasm.dll',
}[process.platform];
if (!platformLibrary || !['arm64', 'x64'].includes(process.arch))
  throw new Error(
    `Unsupported native addon target: ${process.platform}-${process.arch}`,
  );

const cargo = spawnSync(
  'cargo',
  ['build', '-p', 'openpacker-wasm', '--release'],
  { cwd: root, stdio: 'inherit' },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : join(root, 'target');
const nativeDirectory = join(packageRoot, 'dist/native');
const artifact = `openpacker_native.${process.platform}-${process.arch}.node`;
await rm(nativeDirectory, { recursive: true, force: true });
await mkdir(nativeDirectory, { recursive: true });
await copyFile(
  join(targetRoot, 'release', platformLibrary),
  join(nativeDirectory, artifact),
);
await writeFile(
  join(packageRoot, 'dist/esm/native-loader.js'),
  `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport default require('../native/${artifact}');\n`,
);
await writeFile(
  join(packageRoot, 'dist/cjs/native-loader.js'),
  `module.exports = require('../native/${artifact}');\n`,
);
