import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageDirectory = process.argv[2];
if (!packageDirectory)
  throw new Error(
    'Usage: node scripts/write-cjs-package.mjs <package-directory>',
  );

const output = resolve(packageDirectory, 'dist/cjs');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'package.json'), '{"type":"commonjs"}\n');
