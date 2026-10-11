import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { moduleFileFromStack } from './handle-path.js';

const frame = (location: string): string =>
  `Error\n    at loadKoffi (${location})\n    at windowsApi (${location})\n    at async open (node:internal/fs/promises:1:1)`;

describe('moduleFileFromStack', () => {
  it('hands an ESM frame on as a file URL so a drive letter survives', () => {
    const url =
      'file:///D:/a/OpenPacker/OpenPacker/packages/project-io/dist/esm/handle-path.js';
    expect(moduleFileFromStack(frame(`${url}:359:21`))).toBe(url);
  });

  it('takes a CommonJS frame as the Windows path it is', () => {
    const path =
      'D:\\a\\OpenPacker\\OpenPacker\\packages\\project-io\\dist\\cjs\\handle-path.js';
    expect(moduleFileFromStack(frame(`${path}:359:21`))).toBe(path);
  });

  it('keeps spaces in a path', () => {
    const path =
      'C:\\Users\\John Smith\\work\\project-io\\dist\\cjs\\handle-path.js';
    expect(moduleFileFromStack(frame(`${path}:1:1`))).toBe(path);
    const url =
      'file:///C:/Users/John%20Smith/work/project-io/dist/esm/handle-path.js';
    expect(moduleFileFromStack(frame(`${url}:1:1`))).toBe(url);
  });

  it('reads a POSIX frame the same way', () => {
    expect(
      moduleFileFromStack(frame('/srv/app/dist/esm/handle-path.js:9:9')),
    ).toBe('/srv/app/dist/esm/handle-path.js');
    expect(
      moduleFileFromStack(frame('file:///srv/app/dist/esm/handle-path.js:9:9')),
    ).toBe('file:///srv/app/dist/esm/handle-path.js');
  });

  it('answers a frame with no position, and a TypeScript source frame', () => {
    expect(moduleFileFromStack('Error\n    at x (/a/handle-path.js)')).toBe(
      '/a/handle-path.js',
    );
    expect(moduleFileFromStack(frame('/a/src/handle-path.ts:3:4'))).toBe(
      '/a/src/handle-path.ts',
    );
  });

  it('finds nothing in a stack that never passed through this module', () => {
    expect(moduleFileFromStack('')).toBeUndefined();
    expect(moduleFileFromStack(frame('/a/other.js:1:1'))).toBeUndefined();
    expect(moduleFileFromStack(frame('D:\\a\\other.js:1:1'))).toBeUndefined();
  });

  it('yields something createRequire resolves a dependency from', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const url = pathToFileURL(join(here, 'handle-path.js')).href;
    const found = moduleFileFromStack(frame(`${url}:5:5`));
    expect(found).toBe(url);
    expect(createRequire(found as string).resolve('fflate')).toMatch(/fflate/u);
  });
});
