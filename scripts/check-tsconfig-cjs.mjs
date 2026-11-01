#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const offenders = [];

async function walk(dir) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'node_modules' || name.name === 'dist') continue;
      await walk(path);
      continue;
    }
    if (name.name !== 'tsconfig.cjs.json') continue;
    const text = await readFile(path, 'utf8');
    const json = JSON.parse(text);
    const resolution = json.compilerOptions?.moduleResolution;
    if (resolution === 'node10' || resolution === 'Node10') {
      offenders.push(`${path}: moduleResolution=${resolution}`);
    }
  }
}

await walk(join(root, 'packages'));
await walk(join(root, 'apps'));

if (offenders.length > 0) {
  console.error('tsconfig.cjs.json must not use moduleResolution node10 (TypeScript 7):');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}

console.log('check-tsconfig-cjs: ok');
